// ioBroker Script: Enphase Battery Control via Enlighten Cloud API
// Converted from: https://github.com/chinedu40/hacs_enphase_envoy_cloud
//
// Authenticates with email/password at enlighten.enphaseenergy.com and
// controls battery settings (discharge restrict, charge-from-grid, schedules)
// through the internal Enphase cloud REST API.
//
// Includes: login, getCsrfToken, getJwtToken, updateToken, checkToken,
//           changeBatteryDischargeSwitch, readBatteryDischargeStatus,
//           readChargeFromGrid, changeChargeFromGrid,
//           readDischargeSchedules, restoreDischargeSchedules,
//           readChargeSchedules, restoreChargeSchedules,
//           deleteDischargeSchedules, deleteChargeSchedules,
//           getMqttSignedUrl, changeBatteryViaMqtt
//
// Fix history:
//  - login() is correctly called with await inside an async IIFE on startup
//  - Login POST uses redirect:'manual' so 302-cookies are not lost
//  - updateToken() logs response body on error
//  - Redundant standalone call to checkToken() removed

'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const { URLSearchParams } = require('url');

// --- Module check ---
if (typeof fetch !== 'function') {
   log('Module node-fetch is not loaded as a function - script stopped', 'error');
   stopScript();
   return;
}

// -------------------------------------------------------------------------------------------------------------------
// Configuration -- please adjust
// -------------------------------------------------------------------------------------------------------------------
let debug = 0; // Debug level (0=minimal, 1=info, 2=extended, 3=full)

const ENLIGHTEN_BASE  = 'https://enlighten.enphaseenergy.com';
const BATTERY_UI_BASE = 'https://battery-profile-ui.enphaseenergy.com';

// Automatically restore discharge schedules after enabling the RBD switch?
// true = restoreDischargeSchedules() is called after changeBatteryDischargeSwitch(true)
const AUTO_RESTORE_SCHEDULES = true;

// maxDischargeSchedules / maxChargeSchedules and restoreDelayMs are read from ioBroker config datapoints (see below)
let maxDischargeSchedules = 1;     // Default -- overwritten after datapoint creation
let maxChargeSchedules    = 1;     // Default -- overwritten after datapoint creation
let restoreDelayMs        = 15000; // Default -- overwritten after datapoint creation

// ioBroker datapoint paths
const dpBase    = '0_userdata.0.enphase.battery.';
const dpConfig  = dpBase + 'config.';
const dpStatus  = dpBase + 'status.';
const dpControl = dpBase + 'control.';
const dpSchedD  = dpBase + 'schedules.discharge.';
const dpSchedC  = dpBase + 'schedules.charge.';

// Cache file for token persistence (adjust path if necessary)
const CACHE_FILE = path.join('/opt/iobroker/iobroker-data', 'enphase_battery_auth.json');

// -------------------------------------------------------------------------------------------------------------------
// Datapoint creation
// -------------------------------------------------------------------------------------------------------------------
async function ensureStateAsync(id, value, options = { read: true, write: true }) {
   if (!existsState(id)) {
      await createStateAsync(id, value, options);
   }
}

await ensureStateAsync(dpConfig  + 'email',                     '',    { type: 'string',  role: 'text',   read: true,  write: true  });
await ensureStateAsync(dpConfig  + 'password',                  '',    { type: 'string',  role: 'text',   read: true,  write: true  });
await ensureStateAsync(dpStatus  + 'jwt_token',                 '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpStatus  + 'jwt_expires',               '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpStatus  + 'xsrf_token',                '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpStatus  + 'user_id',                   '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpStatus  + 'battery_id',                '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpStatus  + 'last_login',                '',    { type: 'string',  role: 'text',   read: true,  write: false });
await ensureStateAsync(dpControl + 'battery_discharge_restrict',false,  { type: 'boolean', role: 'switch',     read: true,  write: true  });
await ensureStateAsync(dpControl + 'read_battery_status',        false,  { type: 'boolean', role: 'button',     read: true,  write: true  });
await ensureStateAsync(dpStatus  + 'battery_discharge_cloud',    false,  { type: 'boolean', role: 'indicator',  read: true,  write: false });
await ensureStateAsync(dpControl + 'read_charge_from_grid_status', false, { type: 'boolean', role: 'button',    read: true, write: true,
   desc: 'Manually fetch grid-charge status from Enphase cloud' });
await ensureStateAsync(dpControl + 'battery_charge_from_grid_enable',           false,   { type: 'boolean', role: 'switch',    read: true, write: true,
   desc: 'Enable/disable charging the battery from the grid' });
await ensureStateAsync(dpStatus  + 'charge_from_grid_cloud',     false,   { type: 'boolean', role: 'indicator', read: true, write: false,
   desc: 'Current cloud status: charge from grid' });

await ensureStateAsync(dpStatus  + 'battery_grid_mode',          '',      { type: 'string',  role: 'text',      read: true, write: false,
   desc: 'Current batteryGridMode' });

// Schedule configuration from ioBroker (values are read at script startup)
await ensureStateAsync(dpConfig + 'max_discharge_schedules', 1,     { type: 'number', role: 'value', read: true, write: true,
   desc: 'Max number of discharge schedules in ioBroker (restart script after changing)' });
await ensureStateAsync(dpConfig + 'max_charge_schedules',    1,     { type: 'number', role: 'value', read: true, write: true,
   desc: 'Max number of charge schedules in ioBroker (restart script after changing)' });
await ensureStateAsync(dpConfig + 'restore_delay_ms',        15000, { type: 'number', role: 'value', read: true, write: true,
   desc: 'Delay in ms before schedule restore after switch activation' });

// Read configuration values from ioBroker
maxDischargeSchedules = Number(getState(dpConfig + 'max_discharge_schedules').val) || 1;
maxChargeSchedules    = Number(getState(dpConfig + 'max_charge_schedules').val)    || 1;
restoreDelayMs        = Number(getState(dpConfig + 'restore_delay_ms').val)        || 15000;
if (debug >= 1) log(`[Init] Config: max_discharge=${maxDischargeSchedules}, max_charge=${maxChargeSchedules}, restore_delay=${restoreDelayMs}ms`, 'info');

// Schedule control (discharge)
await ensureStateAsync(dpControl + 'read_discharge_schedules',    false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'restore_discharge_schedules', false, { type: 'boolean', role: 'button', read: true, write: true });

// Schedule control (charge)
await ensureStateAsync(dpControl + 'read_charge_schedules',       false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'restore_charge_schedules',    false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'delete_charge_schedules',     false, { type: 'boolean', role: 'button', read: true, write: true,
   desc: 'Delete all charge schedules in Enphase cloud (soft-delete)' });

// Schedule deletion (discharge)
await ensureStateAsync(dpControl + 'delete_discharge_schedules',  false, { type: 'boolean', role: 'button', read: true, write: true,
   desc: 'Delete all discharge schedules in Enphase cloud (soft-delete)' });

// Discharge schedule status (schedules.discharge.*)
await ensureStateAsync(dpSchedD + 'count',    0,  { type: 'number', role: 'value', read: true, write: true,
   desc: 'Number of stored discharge schedules' });
await ensureStateAsync(dpSchedD + 'raw_json', '', { type: 'string', role: 'json',  read: true, write: true,
   desc: 'All discharge schedules as JSON array' });
for (let i = 0; i < maxDischargeSchedules; i++) {
   await ensureStateAsync(dpSchedD + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
   await ensureStateAsync(dpSchedD + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Start time as HH:MM (e.g. "00:05")' });
   await ensureStateAsync(dpSchedD + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'End time as HH:MM (e.g. "00:10")' });
   await ensureStateAsync(dpSchedD + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
   await ensureStateAsync(dpSchedD + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Days of week as JSON array [1=Mon..7=Sun]' });
   await ensureStateAsync(dpSchedD + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Schedule active (isEnabled)' });
}

// Charge schedule status (schedules.charge.*)
await ensureStateAsync(dpSchedC + 'count',    0,  { type: 'number', role: 'value', read: true, write: true,
   desc: 'Number of stored charge schedules' });
await ensureStateAsync(dpSchedC + 'raw_json', '', { type: 'string', role: 'json',  read: true, write: true,
   desc: 'All charge schedules as JSON array' });
for (let i = 0; i < maxChargeSchedules; i++) {
   await ensureStateAsync(dpSchedC + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
   await ensureStateAsync(dpSchedC + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Start time as HH:MM (e.g. "22:00")' });
   await ensureStateAsync(dpSchedC + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'End time as HH:MM (e.g. "06:00")' });
   await ensureStateAsync(dpSchedC + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
   await ensureStateAsync(dpSchedC + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Days of week as JSON array [1=Mon..7=Sun]' });
   await ensureStateAsync(dpSchedC + `${i}_limit`,    100, { type: 'number',  role: 'value', read: true, write: true, desc: 'Charge limit in % (0-100), e.g. 100 = fully charge' });
   await ensureStateAsync(dpSchedC + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Schedule active (isEnabled)' });
}

if (debug >= 1) log('[Init] Datapoints verified/created', 'info');

// -------------------------------------------------------------------------------------------------------------------
// CookieJar: manages all session cookies across multiple HTTP requests
// -------------------------------------------------------------------------------------------------------------------
class CookieJar {
   constructor() {
      this._cookies = new Map(); // name -> value
   }

   /**
    * Parses Set-Cookie header(s) and stores the cookies.
    * Compatible with node-fetch v2 (headers.raw()) and v3 (getSetCookie()).
    * @param {string|string[]} setCookieHeaders - One or more Set-Cookie header strings
    */
   parseAndStore(setCookieHeaders) {
      const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      for (const header of list) {
         if (!header) continue;
         const nameVal = header.split(';')[0].trim();
         const eqIdx   = nameVal.indexOf('=');
         if (eqIdx < 0) continue;
         const name  = nameVal.substring(0, eqIdx).trim();
         const value = nameVal.substring(eqIdx + 1).trim();
         this._cookies.set(name, value);
         if (debug >= 3) log(`[Cookie] Stored: ${name}=${value.substring(0, 30)}...`, 'debug');
      }
   }

   /**
    * Returns the Cookie header string for outgoing requests.
    * @returns {string} Formatted cookie string
    */
   getCookieHeader() {
      return Array.from(this._cookies.entries())
         .map(([name, value]) => `${name}=${value}`)
         .join('; ');
   }

   get(name)        { return this._cookies.get(name); }
   set(name, value) { this._cookies.set(name, value); }
   clear()          { this._cookies.clear(); }
   toJSON()         { return Object.fromEntries(this._cookies); }
   fromJSON(obj)    { for (const [k, v] of Object.entries(obj || {})) this._cookies.set(k, v); }
}

// -------------------------------------------------------------------------------------------------------------------
// EnphaseCloudClient -- main class for login and battery control
// -------------------------------------------------------------------------------------------------------------------
class EnphaseCloudClient {
   constructor(email, password) {
      this.email      = email;
      this.password   = password;
      this.jwtToken   = null;  // JWT Bearer token
      this.jwtExp     = null;  // JWT expiry time (Unix seconds)
      this.xsrfToken  = null;  // BP-XSRF-Token
      this.userId       = null;  // Numeric user ID
      this.batteryId    = null;  // Numeric site/battery ID
      this.supportsMqtt = null;  // null = unknown, true/false after first readBatteryDischargeStatus()
      this.cookieJar    = new CookieJar();
   }

   // ------------------------------------------------
   // _fetch: HTTP request with cookie jar
   //
   // Cookies from Set-Cookie response headers are automatically stored.
   // With redirect:'manual', cookies from 302 intermediate responses are captured correctly.
   //
   // @param {string} url        - Request URL
   // @param {object} options    - fetch options (method, headers, body, redirect, ...)
   // @returns {Response}        - node-fetch Response object
   // ------------------------------------------------
   async _fetch(url, options = {}) {
      options.headers = options.headers || {};

      // Append existing cookies (merge with any existing Cookie header)
      const cookieStr = this.cookieJar.getCookieHeader();
      if (cookieStr) {
         const existing = options.headers['Cookie'] || options.headers['cookie'] || '';
         options.headers['Cookie'] = existing ? `${existing}; ${cookieStr}` : cookieStr;
      }

      if (debug >= 3) log(`[HTTP] ${options.method || 'GET'} ${url}`, 'debug');

      const response = await fetch(url, options);

      // Store Set-Cookie from response -- compatible with node-fetch v2 and v3
      let setCookies = null;
      if (response.headers && typeof response.headers.raw === 'function') {
         setCookies = response.headers.raw()['set-cookie']; // node-fetch v2: array
      } else if (response.headers && typeof response.headers.getSetCookie === 'function') {
         setCookies = response.headers.getSetCookie();       // node-fetch v3 / native fetch
      } else {
         const single = response.headers.get('set-cookie');
         if (single) setCookies = [single];
      }
      if (setCookies && setCookies.length > 0) {
         this.cookieJar.parseAndStore(setCookies);
      }

      if (debug >= 3) log(`[HTTP] Response: ${response.status} ${response.statusText}`, 'debug');
      return response;
   }

   // ------------------------------------------------
   // _jwtPayload: decode the JWT payload from Base64url
   //
   // @param {string} jwt   - JWT string (header.payload.signature)
   // @returns {object|null} Decoded payload object, or null on error
   // ------------------------------------------------
   _jwtPayload(jwt) {
      try {
         const parts = jwt.split('.');
         if (parts.length < 2) return null;
         const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
         return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } catch (e) {
         if (debug >= 1) log(`[JWT] Payload decoding failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
         return null;
      }
   }

   // ------------------------------------------------
   // checkToken: checks whether the JWT is still valid for at least 1 hour
   //
   // @returns {boolean} true if the token is valid, false otherwise
   // ------------------------------------------------
   checkToken() {
      if (!this.jwtToken) {
         if (debug >= 1) log('[checkToken] No JWT token present', 'info');
         return false;
      }
      const exp = this.jwtExp;
      if (!exp || typeof exp !== 'number') {
         if (debug >= 1) log('[checkToken] JWT expiry time not known', 'info');
         return false;
      }
      const nowSec    = Math.floor(Date.now() / 1000);
      const valid     = exp > (nowSec + 3600); // 1 hour buffer
      if (debug >= 1) {
         const remainMin = Math.round((exp - nowSec) / 60);
         log(`[checkToken] JWT expires in ${remainMin} minutes -- valid: ${valid}`, 'info');
      }
      return valid;
   }

   // ------------------------------------------------
   // getCsrfToken: fetch authenticity_token from the login page
   //
   // @returns {string} CSRF token value
   // ------------------------------------------------
   async getCsrfToken() {
      if (debug >= 2) log('[getCsrfToken] Loading Enphase login page', 'info');

      const response = await this._fetch(`${ENLIGHTEN_BASE}/login`);
      if (!response.ok) {
         throw new Error(`Login page not reachable: HTTP ${response.status}`);
      }

      const html  = await response.text();
      const match = html.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/);
      if (!match) {
         throw new Error('authenticity_token not found on login page');
      }

      const token = match[1];
      if (debug >= 2) log(`[getCsrfToken] CSRF token: ${token.substring(0, 20)}...`, 'info');
      return token;
   }

   // ------------------------------------------------
   // getJwtToken: retrieve the JWT token after a successful login
   //
   // Primary:  GET /app-api/jwt_token.json (Python project, proven)
   // Fallback: GET /service/auth_ms_enho/api/v1/session/token (HAR analysis, browser)
   //
   // @returns {string} JWT token string
   // ------------------------------------------------
   async getJwtToken() {
      if (debug >= 1) log('[getJwtToken] Fetching JWT token', 'info');

      // --- Primary path: /app-api/jwt_token.json ---
      let token = null;
      try {
         const resp = await this._fetch(`${ENLIGHTEN_BASE}/app-api/jwt_token.json`);
         if (resp.ok) {
            const data = await resp.json();
            token = data.token || null;
            if (token && debug >= 1) log('[getJwtToken] JWT received via jwt_token.json', 'info');
         } else if (debug >= 1) {
            log(`[getJwtToken] jwt_token.json HTTP ${resp.status} -- trying fallback`, 'warn');
         }
      } catch (e) {
         if (debug >= 1) log(`[getJwtToken] jwt_token.json error: ${e instanceof Error ? e.message : String(e)} -- trying fallback`, 'warn');
      }

      // --- Fallback: auth_ms_enho (browser path from HAR) ---
      if (!token) {
         const sessionHex = this.cookieJar.get('_enlighten_4_session');
         if (!sessionHex) {
            throw new Error('_enlighten_4_session cookie missing and jwt_token.json failed');
         }
         const response = await this._fetch(`${ENLIGHTEN_BASE}/service/auth_ms_enho/api/v1/session/token`, {
            headers: {
               'e-auth-token':     sessionHex,
               'X-Requested-With': 'XMLHttpRequest',
            },
         });
         const rawBody = await response.text();
         if (!response.ok) {
            throw new Error(`JWT retrieval failed: HTTP ${response.status} -- ${rawBody.substring(0, 300)}`);
         }
         let data;
         try {
            data = JSON.parse(rawBody);
         } catch (jsonErr) {
            throw new Error(`JWT fallback: server returned non-JSON (HTTP ${response.status}) -- ${rawBody.substring(0, 150)}`);
         }
         token = data.token || null;
         if (!token) throw new Error('JWT token not present in server response');
         if (debug >= 1) log('[getJwtToken] JWT received via auth_ms_enho', 'info');
      }

      this.jwtToken = token;
      const payload = this._jwtPayload(token);
      this.jwtExp   = (payload && typeof payload.exp === 'number') ? payload.exp : null;

      if (debug >= 1) {
         const expStr = this.jwtExp ? new Date(this.jwtExp * 1000).toISOString() : 'unknown';
         log(`[getJwtToken] JWT valid until: ${expStr}`, 'info');
      }
      return token;
   }

   // ------------------------------------------------
   // _discoverIds: automatically determine user_id and battery_id
   //
   // Follows the redirect after login to extract the site ID from the URL,
   // then fetches app data to resolve the numeric user ID.
   //
   // @returns {void} Sets this.userId and this.batteryId
   // ------------------------------------------------
   async _discoverIds() {
      if (debug >= 1) log('[discoverIds] Determining user ID and battery ID', 'info');

      const homeResp = await this._fetch(`${ENLIGHTEN_BASE}/`, { redirect: 'follow' });
      const finalUrl = homeResp.url;
      if (debug >= 2) log(`[discoverIds] Final URL: ${finalUrl}`, 'info');

      const siteMatch = finalUrl.match(/\/(web|pv\/systems|systems)\/([0-9]+)/);
      if (!siteMatch) {
         throw new Error(`Could not extract site ID from redirect URL: ${finalUrl}`);
      }
      const siteId = siteMatch[2];

      const appUrl  = `${ENLIGHTEN_BASE}/app-api/${siteId}/data.json?app=1&device_status=non_retired&is_mobile=0`;
      if (debug >= 2) log(`[discoverIds] Fetching app data: ${appUrl}`, 'info');
      const appResp = await this._fetch(appUrl);
      if (!appResp.ok) {
         throw new Error(`App data fetch failed: HTTP ${appResp.status}`);
      }

      const appData  = await appResp.json();
      const appBlock = appData.app || {};
      const userId   = appBlock.userId
                    || appBlock.user_id
                    || (appBlock.user && appBlock.user.id);

      if (!userId || !/^\d+$/.test(String(userId))) {
         throw new Error('Could not extract numeric user ID from app data');
      }

      if (!this.batteryId) this.batteryId = String(siteId);
      if (!this.userId)    this.userId    = String(userId);

      if (debug >= 1) log(`[discoverIds] userId=${this.userId}, batteryId=${this.batteryId}`, 'info');
   }

   // ------------------------------------------------
   // updateToken: renew the BP-XSRF-Token
   //
   // POSTs to the isValid endpoint to trigger the server to issue a new
   // BP-XSRF-Token cookie. Falls back to manual Set-Cookie header extraction.
   //
   // @returns {string} The new XSRF token value
   // ------------------------------------------------
   async updateToken() {
      if (debug >= 1) log('[updateToken] Refreshing BP-XSRF-Token', 'info');

      if (!this.batteryId || !this.userId) {
         await this._discoverIds();
      }

      const url     = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules/isValid`;
      const headers = {
         'Content-Type': 'application/json',
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
         'e-auth-token':  this.jwtToken,
         'username':      String(this.userId),
      };

      const response = await this._fetch(url, {
         method:  'POST',
         headers,
         body:    JSON.stringify({ scheduleType: 'dtg' }),
      });

      // BP-XSRF-Token from cookie jar (automatically stored by _fetch)
      let xsrfToken = this.cookieJar.get('BP-XSRF-Token');

      // Fallback: extract manually from Set-Cookie header
      if (!xsrfToken) {
         const setCookie = response.headers.get('set-cookie') || '';
         const match     = setCookie.match(/BP-XSRF-Token=([^;]+)/);
         if (match) {
            xsrfToken = match[1];
            this.cookieJar.set('BP-XSRF-Token', xsrfToken);
         }
      }

      if (!xsrfToken) {
         // Log response body for diagnosis
         const body = await response.text().catch(() => '(no body)');
         throw new Error(`BP-XSRF-Token not received (HTTP ${response.status}): ${body}`);
      }

      this.xsrfToken = xsrfToken;
      if (debug >= 1) log(`[updateToken] XSRF token received: ${xsrfToken.substring(0, 15)}...`, 'info');
      return xsrfToken;
   }

   // ------------------------------------------------
   // login: complete login flow
   //
   // Steps:
   //   1. Fetch CSRF token from login page
   //   2. POST credentials with redirect:'manual' to capture 302-cookies
   //   3. Manually follow redirect
   //   4. Fetch JWT token
   //   5. Discover user/battery IDs
   //   6. Fetch XSRF token
   //   7. Persist tokens to states and cache file
   //
   // Fix: Login POST uses redirect:'manual' so the 302 response with the
   // session cookie (_enlighten_session) is correctly captured by _fetch.
   // With redirect:'follow', cookies from intermediate redirects are lost.
   // ------------------------------------------------
   async login() {
      if (debug >= 1) log('[login] Starting Enphase login', 'info');

      if (!this.email || !this.password) {
         throw new Error('Email and password are required for login');
      }

      // Clear cookies for a clean login
      this.cookieJar.clear();

      // Step 1: get CSRF token
      const authenticityToken = await this.getCsrfToken();

      // Step 2: Login POST with redirect:'manual'
      // IMPORTANT: 'manual' instead of 'follow' -- only this way are cookies from the
      // 302 response (in particular _enlighten_session) captured by the cookie jar.
      const loginPayload = new URLSearchParams({
         'utf8':               '✓',
         'authenticity_token': authenticityToken,
         'user[email]':        this.email,
         'user[password]':     this.password,
      });

      if (debug >= 2) log('[login] Sending login credentials (redirect:manual)', 'info');
      const loginResp = await this._fetch(`${ENLIGHTEN_BASE}/login/login`, {
         method:   'POST',
         headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
         body:     loginPayload.toString(),
         redirect: 'manual', // Fix: 302-cookies are now captured by _fetch
      });

      if (debug >= 2) log(`[login] Login POST response: HTTP ${loginResp.status}`, 'info');

      // Expected responses: 302 (redirect on success) or 200/303
      // Anything other than 4xx/5xx is acceptable
      if (loginResp.status >= 400) {
         const loginBody = await loginResp.text().catch(() => '');
         throw new Error(`Login POST failed: HTTP ${loginResp.status} -- ${loginBody}`);
      }

      // Manually follow redirect (cookies from 302 are now in the cookie jar)
      const location = loginResp.headers.get('location');
      if (location) {
         const redirectUrl = location.startsWith('http') ? location : `${ENLIGHTEN_BASE}${location}`;
         if (debug >= 2) log(`[login] Following redirect to: ${redirectUrl}`, 'info');
         await this._fetch(redirectUrl, { redirect: 'follow' });
      }

      if (debug >= 1) log('[login] Login successful, session cookie stored', 'info');

      // Step 3: fetch JWT token
      await this.getJwtToken();

      // Step 4: discover user/battery IDs
      await this._discoverIds();

      // Step 5: fetch XSRF token
      await this.updateToken();

      // Step 6: persist
      await this._saveToStates();
      this._saveCache();

      if (debug >= 1) log('[login] Login completed successfully', 'info');
   }

   // ------------------------------------------------
   // ensureTokens: ensure valid tokens are present, re-login if necessary
   //
   // @param {boolean} [forceRefresh=false] - Force a new login even if token appears valid
   // @returns {{ jwtToken: string, xsrfToken: string }}
   // ------------------------------------------------
   async ensureTokens(forceRefresh = false) {
      if (forceRefresh || !this.checkToken()) {
         if (debug >= 1) log('[ensureTokens] Token expired/missing -- starting re-login', 'info');
         await this.login();
      } else {
         if (!this.userId || !this.batteryId) {
            await this._discoverIds();
         }
         if (!this.xsrfToken) {
            await this.updateToken();
         }
      }
      return { jwtToken: this.jwtToken, xsrfToken: this.xsrfToken };
   }

   // ------------------------------------------------
   // changeBatteryDischargeSwitch: toggle the "Restrict Battery Discharge" (RBD) mode
   //
   // For systems with supportsMqtt=true: sends the command via MQTT + REST PUT.
   // For older systems (supportsMqtt=false/unknown): uses REST PUT only.
   // Automatically retries with fresh tokens on HTTP 403.
   // If AUTO_RESTORE_SCHEDULES is true and enable=true, triggers schedule restore after restoreDelayMs.
   //
   // @param {boolean} enable - true = restrict discharge active
   // @returns {boolean} true on success
   // ------------------------------------------------
   async changeBatteryDischargeSwitch(enable) {
      log(`[Battery] changeBatteryDischargeSwitch called: enable=${enable}`, 'info');

      // --- Step 1: ensure tokens ---
      if (debug >= 2) log('[Battery] Step 1: checking/fetching tokens (ensureTokens)', 'info');
      await this.ensureTokens();
      if (debug >= 2) log(`[Battery] Tokens OK -- userId=${this.userId}, batteryId=${this.batteryId}`, 'info');
      if (debug >= 2) log(`[Battery] jwtToken=${this.jwtToken ? this.jwtToken.substring(0, 30) + '...' : 'NULL'}`, 'info');
      if (debug >= 2) log(`[Battery] xsrfToken=${this.xsrfToken ? this.xsrfToken.substring(0, 20) + '...' : 'NULL'}`, 'info');
      if (debug >= 3) log(`[Battery] Cookies in jar: ${this.cookieJar.getCookieHeader().replace(/=[^;]{10,}/g, '=***')}`, 'info');

      // --- Step 2: choose path (MQTT for supportsMqtt:true, REST as fallback) ---
      if (debug >= 2) log(`[Battery] Step 2: supportsMqtt=${this.supportsMqtt}`, 'info');

      if (this.supportsMqtt === true) {
         // MQTT path: REST PUT is ignored by the server (returns "success" but changes nothing)
         // --> send setting via MQTT to the device
         if (debug >= 1) log('[Battery] Step 3: MQTT path (supportsMqtt=true)', 'info');
         const mqttInfo = await this.getMqttSignedUrl();
         await this.changeBatteryViaMqtt(enable, mqttInfo);
      } else {
         // REST path: for older systems without MQTT
         if (debug >= 1) log('[Battery] Step 3: REST path (supportsMqtt=false/unknown)', 'info');
         const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?userId=${this.userId}&source=enho`;
         const payload = JSON.stringify({ rbdControl: { enabled: enable } });
         if (debug >= 2) log(`[Battery] PUT ${url}`, 'info');
         if (debug >= 2) log(`[Battery] Payload=${payload}`, 'info');

         const headers = {
            'Content-Type': 'application/json',
            'e-auth-token': this.jwtToken,
            'x-xsrf-token': this.xsrfToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         };
         let response = await this._fetch(url, { method: 'PUT', headers, body: payload });
         const body1  = await response.text();
         if (debug >= 1) log(`[Battery] REST response: HTTP ${response.status}`, response.ok ? 'info' : 'warn');
         if (debug >= 2) log(`[Battery] REST response body: ${body1}`, 'info');

         if (response.status === 403) {
            log('[Battery] 403 -- fetching new tokens and retrying', 'warn');
            await this.ensureTokens(true);
            headers['e-auth-token'] = this.jwtToken;
            headers['x-xsrf-token'] = this.xsrfToken;
            response = await this._fetch(url, { method: 'PUT', headers, body: payload });
            const body2 = await response.text();
            if (debug >= 1) log(`[Battery] REST retry: HTTP ${response.status}`, response.ok ? 'info' : 'warn');
            if (debug >= 2) log(`[Battery] REST retry body: ${body2}`, 'info');
            if (!response.ok) throw new Error(`changeBatteryDischargeSwitch failed: HTTP ${response.status} -- ${body2}`);
         } else if (!response.ok) {
            throw new Error(`changeBatteryDischargeSwitch failed: HTTP ${response.status} -- ${body1}`);
         }
      }

      // --- Step 4: update states ---
      setState(dpControl + 'battery_discharge_restrict', enable, true);
      setState(dpStatus  + 'battery_discharge_cloud',    enable, true);
      log(`[Battery] "Restrict battery discharge" successfully set to ${enable}`, 'info');

      // --- Step 5: automatically restore schedules (if configured) ---
      if (enable && AUTO_RESTORE_SCHEDULES) {
         const storedRaw = getState(dpSchedD + 'raw_json').val;
         const hasStored = storedRaw && storedRaw !== '[]' && storedRaw !== '';
         if (hasStored) {
            if (debug >= 1) log(`[Battery] Auto-restore: waiting ${restoreDelayMs}ms, then restoring schedules`, 'info');
            setTimeout(async () => {
               try {
                  await enphaseClient.restoreDischargeSchedules();
               } catch (err) {
                  log(`[Battery] Auto-restore schedules failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
               }
            }, restoreDelayMs);
         } else {
            if (debug >= 1) log('[Battery] Auto-restore: no stored discharge schedules found (run "read_discharge_schedules" first)', 'info');
         }
      }

      return true;
   }

   // ------------------------------------------------
   // readBatteryDischargeStatus: read the current RBD status from Enphase cloud
   //
   // Reads rbdControl.enabled from GET /batterySettings and updates the
   // corresponding ioBroker states. Also captures supportsMqtt for later use.
   //
   // @returns {boolean|null} true = restriction active, null = field not found
   // ------------------------------------------------
   async readBatteryDischargeStatus() {
      log('[BatteryRead] Reading current "Restrict Battery Discharge" status', 'info');

      // Ensure tokens
      await this.ensureTokens();
      if (debug >= 2) log(`[BatteryRead] userId=${this.userId}, batteryId=${this.batteryId}`, 'info');

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?source=enho&userId=${this.userId}`;
      if (debug >= 2) log(`[BatteryRead] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });

      if (!response.ok) {
         const body = await response.text();
         throw new Error(`readBatteryDischargeStatus failed: HTTP ${response.status} -- ${body}`);
      }

      let data;
      const rawText = await response.text();
      if (debug >= 2) log(`[BatteryRead] HTTP ${response.status} -- raw response: ${rawText}`, 'info');
      try {
         data = JSON.parse(rawText);
      } catch (e) {
         throw new Error(`readBatteryDischargeStatus: response is not valid JSON -- ${rawText.substring(0, 200)}`);
      }

      // Log top-level keys to understand the structure
      if (debug >= 2) log(`[BatteryRead] Top-level keys: ${Object.keys(data).join(', ')}`, 'info');

      // Response structure: { type, timestamp, data: { rbdControl, supportsMqtt, ... } }
      const settings   = data.data || data.batterySettings || data.settings || data;
      const rbdControl = settings.rbdControl;
      const rbdEnabled = rbdControl && typeof rbdControl.enabled === 'boolean'
         ? rbdControl.enabled
         : null;

      if (rbdEnabled === null) {
         log(`[BatteryRead] rbdControl.enabled not found -- rbdControl=${JSON.stringify(rbdControl)}`, 'warn');
      } else {
         if (debug >= 1) log(`[BatteryRead] rbdControl.enabled = ${rbdEnabled}`, 'info');
      }

      // Store supportsMqtt for changeBatteryDischargeSwitch()
      if (typeof settings.supportsMqtt === 'boolean') this.supportsMqtt = settings.supportsMqtt;
      if (debug >= 1) log(`[BatteryRead] supportsMqtt=${settings.supportsMqtt}`, 'info');
      if (debug >= 2) log(`[BatteryRead] requestedConfig=${JSON.stringify(settings.requestedConfig)}`, 'info');
      if (debug >= 2) log(`[BatteryRead] requestedConfigMqtt=${JSON.stringify(settings.requestedConfigMqtt)}`, 'info');

      // Update states
      if (rbdEnabled !== null) {
         setState(dpStatus  + 'battery_discharge_cloud',    rbdEnabled, true);
         setState(dpControl + 'battery_discharge_restrict', rbdEnabled, true);
         if (debug >= 1) log(`[BatteryRead] battery_discharge_restrict = ${rbdEnabled}`, 'info');
      }

      return rbdEnabled;
   }

   // ------------------------------------------------
   // readChargeFromGrid: read the "Charge from Grid" status from Enphase cloud
   //
   // Reads chargeFromGrid (and optionally batteryGridMode) from GET /batterySettings
   // and stores the values in dpStatus+'charge_from_grid_cloud' and
   // dpControl+'battery_charge_from_grid_enable'.
   //
   // @returns {boolean|null} true = grid charging active, null = field not found
   // ------------------------------------------------
   async readChargeFromGrid() {
      log('[GridCharge] Reading "Charge from Grid" status from Enphase cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?source=enho&userId=${this.userId}`;
      if (debug >= 2) log(`[GridCharge] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });

      if (!response.ok) {
         const body = await response.text();
         throw new Error(`readChargeFromGrid failed: HTTP ${response.status} -- ${body}`);
      }

      const rawText = await response.text();
      let data;
      try {
         data = JSON.parse(rawText);
      } catch (e) {
         throw new Error(`readChargeFromGrid: not valid JSON -- ${rawText.substring(0, 200)}`);
      }

      // Response structure: { type, timestamp, data: { ... } }
      const settings = data.data || data.batterySettings || data.settings || data;

      // --- Grid charging enabled/disabled ---
      const gridChargeEnabled = typeof settings.chargeFromGrid === 'boolean' ? settings.chargeFromGrid : null;
      if (gridChargeEnabled === null) {
         log(`[GridCharge] Field 'chargeFromGrid' not found -- keys: ${Object.keys(settings).join(', ')}`, 'warn');
      } else {
         setState(dpStatus  + 'charge_from_grid_cloud', gridChargeEnabled, true);
         setState(dpControl + 'battery_charge_from_grid_enable',       gridChargeEnabled, true);
         if (debug >= 1) log(`[GridCharge] chargeFromGrid = ${gridChargeEnabled}`, 'info');
      }

      // --- Additional status fields (informational) ---
      const gridMode = typeof settings.batteryGridMode === 'string' ? settings.batteryGridMode : '';
      if (gridMode) {
         setState(dpStatus + 'battery_grid_mode', gridMode, true);
         if (debug >= 1) log(`[GridCharge] batteryGridMode = ${gridMode}`, 'info');
      }
      if (debug >= 2) {
         log(`[GridCharge] chargeFromGridScheduleEnabled=${settings.chargeFromGridScheduleEnabled}`, 'info');
         log(`[GridCharge] chargeBeginTime=${settings.chargeBeginTime}, chargeEndTime=${settings.chargeEndTime}`, 'info');
      }

      if (debug >= 1) log('[GridCharge] Grid-charge status stored', 'info');
      return gridChargeEnabled;
   }

   // ------------------------------------------------
   // changeChargeFromGrid: enable or disable "Charge from Grid"
   //
   // Sends chargeFromGrid via PUT /batterySettings.
   // Automatically retries with fresh tokens on HTTP 403.
   //
   // @param {boolean} enable - true = grid charging active
   // @returns {boolean} true on success
   // ------------------------------------------------
   async changeChargeFromGrid(enable) {
      log(`[GridCharge] changeChargeFromGrid called: enable=${enable}`, 'info');
      await this.ensureTokens();
      if (debug >= 2) log(`[GridCharge] Tokens OK -- userId=${this.userId}, batteryId=${this.batteryId}`, 'info');

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?userId=${this.userId}&source=enho`;
      const headers = {
         'Content-Type': 'application/json',
         'e-auth-token': this.jwtToken,
         'x-xsrf-token': this.xsrfToken,
         'username':     String(this.userId),
         'origin':       BATTERY_UI_BASE,
         'referer':      BATTERY_UI_BASE + '/',
      };

      const payload = JSON.stringify({ chargeFromGrid: enable });
      if (debug >= 2) log(`[GridCharge] PUT ${url}`, 'info');
      if (debug >= 2) log(`[GridCharge] Payload: ${payload}`, 'info');

      let response = await this._fetch(url, { method: 'PUT', headers, body: payload });
      const body1  = await response.text();
      if (debug >= 1) log(`[GridCharge] Response: HTTP ${response.status}`, response.ok ? 'info' : 'warn');
      if (debug >= 2) log(`[GridCharge] Response body: ${body1}`, 'info');

      if (response.status === 403) {
         log('[GridCharge] 403 -- fetching new tokens and retrying', 'warn');
         await this.ensureTokens(true);
         headers['e-auth-token'] = this.jwtToken;
         headers['x-xsrf-token'] = this.xsrfToken;
         response = await this._fetch(url, { method: 'PUT', headers, body: payload });
         const body2 = await response.text();
         if (debug >= 1) log(`[GridCharge] Retry: HTTP ${response.status}`, response.ok ? 'info' : 'warn');
         if (debug >= 2) log(`[GridCharge] Retry body: ${body2}`, 'info');
         if (!response.ok) throw new Error(`changeChargeFromGrid failed: HTTP ${response.status} -- ${body2}`);
      } else if (!response.ok) {
         throw new Error(`changeChargeFromGrid failed: HTTP ${response.status} -- ${body1}`);
      }

      setState(dpStatus  + 'charge_from_grid_cloud', enable, true);
      setState(dpControl + 'battery_charge_from_grid_enable',       enable, true);
      log(`[GridCharge] "Charge from Grid" successfully set to ${enable}`, 'info');
      return true;
   }

   // ------------------------------------------------
   // readDischargeSchedules: fetch RBD schedules from Enphase cloud and store in ioBroker
   //
   // API: GET /service/batteryConfig/api/v1/battery/sites/{siteId}/schedules
   // Only schedules with scheduleType="RBD" that are not soft-deleted are stored.
   // If more schedules exist than maxDischargeSchedules, auto-expands the limit and creates
   // the missing ioBroker datapoints.
   // If Enphase reports 0 schedules, the existing ioBroker config is left unchanged.
   //
   // @returns {Array} Active RBD schedules
   // ------------------------------------------------
   async readDischargeSchedules() {
      log('[SchedD] Reading RBD schedules from Enphase cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;
      if (debug >= 2) log(`[SchedD] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`readDischargeSchedules failed: HTTP ${response.status} -- ${text}`);

      // API response structure: { type:"BATTERY_SCHEDULES_CONFIG", rbd:{count:N, details:[...]}, cfg:{...}, dtg:{...} }
      // RBD schedules are under parsed.rbd.details
      let rbdSchedules;
      try {
         const parsed = JSON.parse(text);
         if (debug >= 1) log(`[SchedD] Response type: ${parsed.type}, rbd.count=${parsed.rbd?.count ?? 'n/a'}`, 'info');
         if (debug >= 3) log(`[SchedD] Full response: ${text}`, 'info');
         rbdSchedules = (parsed.rbd && Array.isArray(parsed.rbd.details))
            ? parsed.rbd.details.filter(s => !s.isDeleted)
            : [];
      } catch (e) {
         throw new Error(`readDischargeSchedules: not valid JSON -- ${text.substring(0, 200)}`);
      }

      const storeCount = rbdSchedules.length;
      if (debug >= 1) log(`[SchedD] ${storeCount} active RBD schedule(s) found`, 'info');

      // No schedules at Enphase --> leave existing ioBroker config unchanged
      if (storeCount === 0) {
         if (debug >= 1) log('[SchedD] Enphase reports 0 schedules -- stored ioBroker config remains unchanged', 'info');
         return rbdSchedules;
      }

      // More schedules than configured --> raise max_discharge_schedules + create missing datapoints
      if (storeCount > maxDischargeSchedules) {
         log(`[SchedD] ${storeCount} discharge schedules found, max_discharge_schedules=${maxDischargeSchedules} -- auto-adjusting`, 'info');
         const oldMax = maxDischargeSchedules;
         maxDischargeSchedules = storeCount;
         setState(dpConfig + 'max_discharge_schedules', storeCount, true);
         if (debug >= 1) log(`[SchedD] config.max_discharge_schedules set to ${storeCount}`, 'info');
         // Create missing datapoints for new slots
         for (let i = oldMax; i < storeCount; i++) {
            await ensureStateAsync(dpSchedD + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
            await ensureStateAsync(dpSchedD + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Start time as HH:MM' });
            await ensureStateAsync(dpSchedD + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'End time as HH:MM' });
            await ensureStateAsync(dpSchedD + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
            await ensureStateAsync(dpSchedD + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Days of week [1=Mon..7=Sun]' });
            await ensureStateAsync(dpSchedD + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Schedule active (isEnabled)' });
            if (debug >= 2) log(`[SchedD] Datapoints for slot ${i} created`, 'info');
         }
      }

      // Save to ioBroker (only when schedules are present)
      await setStateAsync(dpSchedD + 'count',    storeCount, true);
      await setStateAsync(dpSchedD + 'raw_json', JSON.stringify(rbdSchedules), true);

      for (let i = 0; i < maxDischargeSchedules; i++) {
         const s = rbdSchedules[i] || null;
         await setStateAsync(dpSchedD + `${i}_json`,      s ? JSON.stringify(s) : '', true);
         await setStateAsync(dpSchedD + `${i}_startTime`, s ? (s.startTime || '') : '', true);
         await setStateAsync(dpSchedD + `${i}_endTime`,   s ? (s.endTime   || '') : '', true);
         await setStateAsync(dpSchedD + `${i}_timezone`,  s ? (s.timezone  || '') : '', true);
         await setStateAsync(dpSchedD + `${i}_days`,      s ? JSON.stringify(s.days || []) : '[]', true);
         await setStateAsync(dpSchedD + `${i}_enabled`,   s ? !!s.isEnabled : false, true);
         if (debug >= 2 && s) log(`[SchedD]   [${i}] ${s.startTime}-${s.endTime} ${JSON.stringify(s.days)} (${s.scheduleId})`, 'info');
      }

      if (debug >= 1) log(`[SchedD] ${Math.min(storeCount, maxDischargeSchedules)} RBD schedule(s) stored in ioBroker`, 'info');
      return rbdSchedules;
   }

   // ------------------------------------------------
   // restoreDischargeSchedules: restore missing RBD schedules from ioBroker
   //
   // Strategy: soft-delete all current cloud schedules via PUT isDeleted:true,
   // then re-create all stored ioBroker schedules via POST.
   // Useful after changeBatteryDischargeSwitch(true) because the server may delete schedules.
   //
   // @returns {void}
   // ------------------------------------------------
   async restoreDischargeSchedules() {
      log('[SchedD] Restoring RBD schedules (delete-all then create-all)', 'info');
      await this.ensureTokens();

      // Load stored schedules from ioBroker
      const storedRaw = getState(dpSchedD + 'raw_json').val;
      let storedSchedules = [];
      try { storedSchedules = JSON.parse(storedRaw || '[]'); } catch (e) { /* ignore */ }

      if (!storedSchedules || storedSchedules.length === 0) {
         log('[SchedD] No stored discharge schedules found -- run "read_discharge_schedules" first', 'warn');
         return;
      }
      if (debug >= 1) log(`[SchedD] ${storedSchedules.length} stored discharge schedule(s) will be restored`, 'info');

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      // Step 1: read current cloud schedules and soft-delete all of them
      const currentSchedules = await this.readDischargeSchedules();
      let deleted = 0;
      for (const s of currentSchedules) {
         if (!s.scheduleId) continue;
         const delPayload = {
            startTime:    s.startTime,
            endTime:      s.endTime,
            days:         s.days,
            timezone:     s.timezone,
            scheduleType: s.scheduleType,
            isDeleted:    true,
            isEnabled:    s.isEnabled !== undefined ? s.isEnabled : true,
         };
         if (debug >= 2) log(`[SchedD] Soft-delete ${s.scheduleId} -- ${s.startTime}-${s.endTime}`, 'info');
         const delResp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(delPayload),
         });
         const delText = await delResp.text();
         if (delResp.ok) { deleted++; }
         else { log(`[SchedD] Soft-delete failed (HTTP ${delResp.status}): ${delText}`, 'warn'); }
      }
      if (debug >= 1) log(`[SchedD] ${deleted}/${currentSchedules.length} schedule(s) deleted`, 'info');

      // Step 2: re-create all stored schedules
      let restored = 0;
      for (const s of storedSchedules) {
         const payload = {
            timezone:     s.timezone,
            startTime:    s.startTime,
            endTime:      s.endTime,
            scheduleType: s.scheduleType,
            days:         s.days,
            isEnabled:    s.isEnabled !== undefined ? s.isEnabled : true,
         };

         if (debug >= 2) log(`[SchedD] POST -- ${payload.startTime}-${payload.endTime} ${JSON.stringify(payload.days)}`, 'info');
         const resp = await this._fetch(schedUrl, {
            method:  'POST',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const respText = await resp.text();
         if (resp.ok) {
            if (debug >= 2) log(`[SchedD] Schedule created (HTTP ${resp.status}): ${respText.substring(0, 100)}`, 'info');
            restored++;
         } else {
            log(`[SchedD] Error creating schedule ${payload.startTime}-${payload.endTime}: HTTP ${resp.status} -- ${respText}`, 'warn');
         }
      }

      if (debug >= 1) log(`[SchedD] Restore complete: ${restored}/${storedSchedules.length} schedule(s) created`, 'info');

      // Save updated state
      if (restored > 0) await this.readDischargeSchedules();
   }

   // ------------------------------------------------
   // readChargeSchedules: fetch charge schedules (CFG) from Enphase cloud and store in ioBroker
   //
   // Uses the same schedules endpoint as readDischargeSchedules.
   // Charge schedules are under parsed.cfg.details (scheduleType="CFG" or similar).
   // Falls back to parsed.dtg.details if cfg is empty.
   // Auto-expands maxChargeSchedules if more schedules exist than configured.
   //
   // @returns {Array} Active charge schedules
   // ------------------------------------------------
   async readChargeSchedules() {
      log('[SchedC] Reading charge schedules from Enphase cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;
      if (debug >= 2) log(`[SchedC] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`readChargeSchedules failed: HTTP ${response.status} -- ${text}`);

      // API response structure: { type:"BATTERY_SCHEDULES_CONFIG", rbd:{...}, cfg:{count:N, details:[...]}, dtg:{...} }
      // Charge schedules are under parsed.cfg.details
      let cfgSchedules;
      try {
         const parsed = JSON.parse(text);
         if (debug >= 1) log(`[SchedC] Response type: ${parsed.type}, cfg.count=${parsed.cfg?.count ?? 'n/a'}, dtg.count=${parsed.dtg?.count ?? 'n/a'}`, 'info');
         if (debug >= 3) log(`[SchedC] Full response: ${text}`, 'info');
         cfgSchedules = (parsed.cfg && Array.isArray(parsed.cfg.details))
            ? parsed.cfg.details.filter(s => !s.isDeleted)
            : [];
         if (cfgSchedules.length === 0 && parsed.dtg && Array.isArray(parsed.dtg.details)) {
            // Fallback: check dtg section if cfg is empty
            if (debug >= 2) log('[SchedC] cfg empty -- checking dtg section as fallback', 'info');
            cfgSchedules = parsed.dtg.details.filter(s => !s.isDeleted);
         }
      } catch (e) {
         throw new Error(`readChargeSchedules: not valid JSON -- ${text.substring(0, 200)}`);
      }

      const storeCount = cfgSchedules.length;
      if (debug >= 1) log(`[SchedC] ${storeCount} active charge schedule(s) found`, 'info');

      // No schedules at Enphase --> leave existing ioBroker config unchanged
      if (storeCount === 0) {
         if (debug >= 1) log('[SchedC] Enphase reports 0 charge schedules -- stored ioBroker config remains unchanged', 'info');
         return cfgSchedules;
      }

      // More schedules than configured --> raise max_charge_schedules + create missing datapoints
      if (storeCount > maxChargeSchedules) {
         log(`[SchedC] ${storeCount} charge schedules found, max_charge_schedules=${maxChargeSchedules} -- auto-adjusting`, 'info');
         const oldMax = maxChargeSchedules;
         maxChargeSchedules = storeCount;
         setState(dpConfig + 'max_charge_schedules', storeCount, true);
         if (debug >= 1) log(`[SchedC] config.max_charge_schedules set to ${storeCount}`, 'info');
         for (let i = oldMax; i < storeCount; i++) {
            await ensureStateAsync(dpSchedC + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
            await ensureStateAsync(dpSchedC + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Start time as HH:MM' });
            await ensureStateAsync(dpSchedC + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'End time as HH:MM' });
            await ensureStateAsync(dpSchedC + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
            await ensureStateAsync(dpSchedC + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Days of week [1=Mon..7=Sun]' });
            await ensureStateAsync(dpSchedC + `${i}_limit`,    100, { type: 'number',  role: 'value', read: true, write: true, desc: 'Charge limit in % (0-100)' });
            await ensureStateAsync(dpSchedC + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Schedule active (isEnabled)' });
            if (debug >= 2) log(`[SchedC] Datapoints for slot ${i} created`, 'info');
         }
      }

      // Save to ioBroker
      await setStateAsync(dpSchedC + 'count',    storeCount, true);
      await setStateAsync(dpSchedC + 'raw_json', JSON.stringify(cfgSchedules), true);

      for (let i = 0; i < maxChargeSchedules; i++) {
         const s = cfgSchedules[i] || null;
         await setStateAsync(dpSchedC + `${i}_json`,      s ? JSON.stringify(s) : '', true);
         await setStateAsync(dpSchedC + `${i}_startTime`, s ? (s.startTime || '') : '', true);
         await setStateAsync(dpSchedC + `${i}_endTime`,   s ? (s.endTime   || '') : '', true);
         await setStateAsync(dpSchedC + `${i}_timezone`,  s ? (s.timezone  || '') : '', true);
         await setStateAsync(dpSchedC + `${i}_days`,      s ? JSON.stringify(s.days || []) : '[]', true);
         await setStateAsync(dpSchedC + `${i}_limit`,     s && s.limit !== undefined ? s.limit : 100, true);
         await setStateAsync(dpSchedC + `${i}_enabled`,   s ? !!s.isEnabled : false, true);
         if (debug >= 2 && s) log(`[SchedC]   [${i}] ${s.startTime}-${s.endTime} ${JSON.stringify(s.days)} (${s.scheduleId})`, 'info');
      }

      if (debug >= 1) log(`[SchedC] ${Math.min(storeCount, maxChargeSchedules)} charge schedule(s) stored in ioBroker`, 'info');
      return cfgSchedules;
   }

   // ------------------------------------------------
   // restoreChargeSchedules: restore charge schedules from ioBroker to Enphase cloud
   //
   // Strategy: soft-delete all current cloud charge schedules via PUT isDeleted:true,
   // then re-create all stored ioBroker schedules via POST.
   //
   // @returns {void}
   // ------------------------------------------------
   async restoreChargeSchedules() {
      log('[SchedC] Restoring charge schedules (delete-all then create-all)', 'info');
      await this.ensureTokens();

      const storedRaw = getState(dpSchedC + 'raw_json').val;
      let storedSchedules = [];
      try {
         storedSchedules = JSON.parse(storedRaw || '[]');
      } catch (e) { /* ignore */ }

      if (!storedSchedules || storedSchedules.length === 0) {
         log('[SchedC] No stored charge schedules found -- run "read_charge_schedules" first', 'warn');
         return;
      }
      if (debug >= 1) log(`[SchedC] ${storedSchedules.length} stored charge schedule(s) as reference`, 'info');

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      // Step 1: read current cloud schedules and soft-delete all of them
      const currentSchedules = await this.readChargeSchedules();
      if (debug >= 1) log(`[SchedC] ${currentSchedules.length} existing cloud schedule(s) will be deleted`, 'info');
      let deleted = 0;
      for (const s of currentSchedules) {
         const delUrl = `${schedUrl}/${s.scheduleId}`;
         if (debug >= 2) log(`[SchedC] Soft-delete ${s.scheduleId} (${s.startTime}-${s.endTime})`, 'info');
         const delResp = await this._fetch(delUrl, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify({ isDeleted: true }),
         });
         const delText = await delResp.text();
         if (delResp.ok) { deleted++; }
         else { log(`[SchedC] Soft-delete failed (HTTP ${delResp.status}): ${delText}`, 'warn'); }
      }
      if (debug >= 1) log(`[SchedC] ${deleted}/${currentSchedules.length} schedule(s) deleted`, 'info');

      // Step 2: re-create all stored schedules
      let restored = 0;
      for (const s of storedSchedules) {
         const payload = {
            timezone:     s.timezone,
            startTime:    s.startTime,
            endTime:      s.endTime,
            scheduleType: s.scheduleType,
            days:         s.days,
            isEnabled:    s.isEnabled !== undefined ? s.isEnabled : true,
         };
         if (s.limit !== undefined) payload.limit = s.limit;

         if (debug >= 2) log(`[SchedC] POST -- ${payload.startTime}-${payload.endTime} limit=${payload.limit ?? '-'}% ${JSON.stringify(payload.days)}`, 'info');
         const resp = await this._fetch(schedUrl, {
            method:  'POST',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const respText = await resp.text();
         if (resp.ok) {
            if (debug >= 2) log(`[SchedC] Schedule created (HTTP ${resp.status}): ${respText.substring(0, 100)}`, 'info');
            restored++;
         } else {
            log(`[SchedC] Error creating schedule ${payload.startTime}-${payload.endTime}: HTTP ${resp.status} -- ${respText}`, 'warn');
         }
      }

      if (debug >= 1) log(`[SchedC] Restore complete: ${restored}/${storedSchedules.length} charge schedule(s) created`, 'info');
      if (restored > 0) await this.readChargeSchedules();
   }

   // ------------------------------------------------
   // deleteDischargeSchedules: soft-delete all RBD discharge schedules in Enphase cloud
   //
   // Sends PUT isDeleted:true for each active schedule, then clears the ioBroker datapoints.
   //
   // @returns {void}
   // ------------------------------------------------
   async deleteDischargeSchedules() {
      log('[SchedD] Deleting all discharge schedules in Enphase cloud', 'info');
      await this.ensureTokens();

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      const currentSchedules = await this.readDischargeSchedules();
      if (currentSchedules.length === 0) {
         if (debug >= 1) log('[SchedD] No active discharge schedules in cloud -- clearing ioBroker states', 'info');
      }

      let deleted = 0;
      for (const s of currentSchedules) {
         if (!s.scheduleId) continue;
         const payload = {
            scheduleType: s.scheduleType,
            startTime:    s.startTime,
            endTime:      s.endTime,
            days:         s.days,
            timezone:     s.timezone,
            isEnabled:    s.isEnabled !== undefined ? s.isEnabled : true,
            isDeleted:    true,
         };
         if (debug >= 2) log(`[SchedD] Soft-delete ${s.scheduleId} -- ${s.startTime}-${s.endTime}`, 'info');
         const resp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const text = await resp.text();
         if (resp.ok) { deleted++; }
         else { log(`[SchedD] Soft-delete failed (HTTP ${resp.status}): ${text}`, 'warn'); }
      }
      if (debug >= 1) log(`[SchedD] ${deleted}/${currentSchedules.length} discharge schedule(s) deleted`, 'info');

      // Clear ioBroker datapoints (only on manual deletion)
      await setStateAsync(dpSchedD + 'count',    0,    true);
      await setStateAsync(dpSchedD + 'raw_json', '[]', true);
      for (let i = 0; i < maxDischargeSchedules; i++) {
         await setStateAsync(dpSchedD + `${i}_json`,      '',   true);
         await setStateAsync(dpSchedD + `${i}_startTime`, '',   true);
         await setStateAsync(dpSchedD + `${i}_endTime`,   '',   true);
         await setStateAsync(dpSchedD + `${i}_timezone`,  '',   true);
         await setStateAsync(dpSchedD + `${i}_days`,      '[]', true);
         await setStateAsync(dpSchedD + `${i}_enabled`,   false, true);
      }
      if (debug >= 1) log('[SchedD] ioBroker datapoints for discharge schedules cleared', 'info');
   }

   // ------------------------------------------------
   // deleteChargeSchedules: soft-delete all CFG charge schedules in Enphase cloud
   //
   // Sends PUT isDeleted:true for each active schedule, then clears the ioBroker datapoints.
   //
   // @returns {void}
   // ------------------------------------------------
   async deleteChargeSchedules() {
      log('[SchedC] Deleting all charge schedules in Enphase cloud', 'info');
      await this.ensureTokens();

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      const currentSchedules = await this.readChargeSchedules();
      if (currentSchedules.length === 0) {
         if (debug >= 1) log('[SchedC] No active charge schedules in cloud -- clearing ioBroker states', 'info');
      }

      let deleted = 0;
      for (const s of currentSchedules) {
         if (!s.scheduleId) continue;
         const payload = {
            scheduleType: s.scheduleType,
            startTime:    s.startTime,
            endTime:      s.endTime,
            days:         s.days,
            timezone:     s.timezone,
            isEnabled:    s.isEnabled !== undefined ? s.isEnabled : true,
            isDeleted:    true,
         };
         if (debug >= 2) log(`[SchedC] Soft-delete ${s.scheduleId} -- ${s.startTime}-${s.endTime}`, 'info');
         const resp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const text = await resp.text();
         if (resp.ok) { deleted++; }
         else { log(`[SchedC] Soft-delete failed (HTTP ${resp.status}): ${text}`, 'warn'); }
      }
      if (debug >= 1) log(`[SchedC] ${deleted}/${currentSchedules.length} charge schedule(s) deleted`, 'info');

      // Clear ioBroker datapoints (only on manual deletion)
      await setStateAsync(dpSchedC + 'count',    0,    true);
      await setStateAsync(dpSchedC + 'raw_json', '[]', true);
      for (let i = 0; i < maxChargeSchedules; i++) {
         await setStateAsync(dpSchedC + `${i}_json`,      '',   true);
         await setStateAsync(dpSchedC + `${i}_startTime`, '',   true);
         await setStateAsync(dpSchedC + `${i}_endTime`,   '',   true);
         await setStateAsync(dpSchedC + `${i}_timezone`,  '',   true);
         await setStateAsync(dpSchedC + `${i}_days`,      '[]', true);
         await setStateAsync(dpSchedC + `${i}_limit`,     100,  true);
         await setStateAsync(dpSchedC + `${i}_enabled`,   false, true);
      }
      if (debug >= 1) log('[SchedC] ioBroker datapoints for charge schedules cleared', 'info');
   }

   // ------------------------------------------------
   // getMqttSignedUrl: fetch a signed WebSocket URL for AWS IoT MQTT
   //
   // @returns {object} mqttInfo object with aws_iot_endpoint, aws_authorizer,
   //                   aws_token_key, aws_token_value, aws_digest, topic
   // ------------------------------------------------
   async getMqttSignedUrl() {
      if (debug >= 2) log('[MQTT] Fetching MQTT signed URL', 'info');
      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/mqttSignedUrl/${this.batteryId}`;
      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });
      const text = await response.text();
      if (debug >= 2) log(`[MQTT] Signed URL response (HTTP ${response.status})`, 'info');
      if (debug >= 3) log(`[MQTT] Signed URL response body: ${text}`, 'info');
      if (!response.ok) throw new Error(`getMqttSignedUrl failed: HTTP ${response.status} -- ${text}`);
      return JSON.parse(text);
   }

   // ------------------------------------------------
   // changeBatteryViaMqtt: send RBD setting for systems with supportsMqtt:true
   //
   // Key insight from browser source analysis (battery-profile-ui):
   //   1. WS URL has NO query parameters -- auth goes as MQTT username
   //   2. MQTT username = "?x-amz-customauthorizer-name=...&enph_token=...&site-id=...&signature=...&env=..."
   //   3. MQTT 3.1.1 (level 4), no password
   //   4. Origin = BATTERY_UI_BASE (not enlighten)
   //   5. Browser subscribes to response topic, sends command via REST PUT
   //   6. We also attempt REST PUT on the battery-profile-ui endpoint
   //
   // @param {boolean} enable    - true = restrict discharge active
   // @param {object}  mqttInfo  - return value from getMqttSignedUrl()
   // @returns {Promise<boolean>} resolves true on success
   // ------------------------------------------------
   async changeBatteryViaMqtt(enable, mqttInfo) {
      let mqtt;
      try {
         // @ts-ignore
         mqtt = require('mqtt');
      } catch (e) {
         throw new Error('mqtt package not available -- install with: npm install mqtt');
      }

      // mqttInfo fields:
      //   aws_iot_endpoint  --> MQTT broker host
      //   aws_authorizer    --> custom authorizer name
      //   aws_token_key     --> query param name (e.g. "enph_token")
      //   aws_token_value   --> session token value
      //   aws_digest        --> base64 signature (encodeURIComponent-encoded)
      //   topic             --> response stream topic (v1/server/response-stream/{sessionId})
      const endpoint      = mqttInfo.aws_iot_endpoint;
      const authorizer    = mqttInfo.aws_authorizer;
      const tokenKey      = mqttInfo.aws_token_key;
      const tokenValue    = mqttInfo.aws_token_value;
      const digest        = mqttInfo.aws_digest;
      const responseTopic = mqttInfo.topic;

      if (!endpoint) throw new Error(`aws_iot_endpoint missing in mqttInfo: ${JSON.stringify(Object.keys(mqttInfo))}`);

      // Session ID from the response topic
      const sessionId = responseTopic ? responseTopic.split('/').pop() : '';
      if (debug >= 2) log(`[MQTT] Session ID: ${sessionId}`, 'info');

      // Client ID in Paho-MQTT style (browser: bp-paho-mqtt-{4 random chars})
      const mqttClientId = `bp-paho-mqtt-${Math.random().toString(36).substring(2, 6)}`;
      if (debug >= 2) log(`[MQTT] Client ID: ${mqttClientId}`, 'info');

      // KEY INSIGHT (from battery-UI JS analysis):
      // WS URL has NO query parameters!
      // Auth data goes as MQTT username (format as Paho builds it):
      //   "?x-amz-customauthorizer-name=AUTHORIZER&TOKEN_KEY=TOKEN_VALUE&site-id=SITE_ID&x-amz-customauthorizer-signature=ENCODED_DIGEST&env=production"
      // Digest is encodeURIComponent-encoded, all other values are NOT.
      const wsUrl       = `wss://${endpoint}/mqtt`;
      const mqttUsername = `?x-amz-customauthorizer-name=${authorizer}` +
         `&${tokenKey}=${tokenValue}` +
         `&site-id=${this.batteryId}` +
         `&x-amz-customauthorizer-signature=${encodeURIComponent(digest)}` +
         `&env=production`;

      if (debug >= 3) log(`[MQTT] WSS URL: ${wsUrl}  (no query params)`, 'info');
      if (debug >= 3) log(`[MQTT] MQTT username: ?x-amz-customauthorizer-name=${authorizer}&${tokenKey}=***&site-id=${this.batteryId}&...`, 'info');
      if (debug >= 2) log(`[MQTT] Response topic (subscribe): ${responseTopic}`, 'info');

      // Establish MQTT connection
      return new Promise((resolve, reject) => {
         if (debug >= 2) log('[MQTT] Starting MQTT connection (MQTT 3.1.1, auth via username)', 'info');

         let settled = false;
         const settle = (fn, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(val);
         };

         let client;
         try {
            client = mqtt.connect(wsUrl, {
               clientId:        mqttClientId,
               protocolVersion: 4,       // MQTT 3.1.1
               protocolId:      'MQTT',
               username:        mqttUsername, // auth as MQTT username
               // no password
               reconnectPeriod: 0,
               connectTimeout:  20000,
               keepalive:       60,
               clean:           true,
               wsOptions:       {
                  protocols: 'mqtt',
                  headers:   { 'Origin': BATTERY_UI_BASE },
               },
            });
         } catch (e) {
            reject(new Error(`mqtt.connect() error: ${e instanceof Error ? e.message : String(e)}`));
            return;
         }
         if (debug >= 2) log('[MQTT] Waiting for connect event', 'info');

         const timer = setTimeout(() => {
            log('[MQTT] Timeout (20s)', 'warn');
            client.end(true);
            settle(reject, new Error('MQTT connection timeout (20s)'));
         }, 20000);

         client.on('connect', async () => {
            if (debug >= 2) log('[MQTT] Connected (CONNACK 0x00)', 'info');

            // Subscribe to response topic (browser does this too)
            client.subscribe(responseTopic, { qos: 1 }, (subErr) => {
               if (subErr) log(`[MQTT] Subscribe error: ${subErr.message}`, 'warn');
               else if (debug >= 2) log(`[MQTT] Subscribed: ${responseTopic}`, 'info');
            });

            // Send battery setting via REST PUT (as browser does it)
            // API backend is on enlighten.enphaseenergy.com (window.build_domain_api from battery-profile-ui HTML)
            // Browser uses SET_BATTERY_CONFIG = "/batterySettings/@SITE_ID?@USER_ID" (no source=enho)
            const batteryUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?userId=${this.userId}`;
            const payload    = JSON.stringify({ rbdControl: { enabled: enable } });
            if (debug >= 2) log(`[MQTT] REST PUT ${batteryUrl}`, 'info');
            if (debug >= 2) log(`[MQTT] REST payload: ${payload}`, 'info');

            try {
               const restHeaders = {
                  'Content-Type':  'application/json',
                  'e-auth-token':  this.jwtToken,
                  'x-xsrf-token':  this.xsrfToken,
                  'username':      String(this.userId),
                  'origin':        BATTERY_UI_BASE,
                  'referer':       BATTERY_UI_BASE + '/',
               };
               const restResp = await this._fetch(batteryUrl, { method: 'PUT', headers: restHeaders, body: payload });
               const restBody = await restResp.text();
               if (debug >= 1) log(`[MQTT] REST response: HTTP ${restResp.status}`, restResp.ok ? 'info' : 'warn');
               if (debug >= 2) log(`[MQTT] REST response body: ${restBody}`, 'info');

               if (restResp.ok) {
                  // Wait 10s for possible MQTT response, then resolve
                  setTimeout(() => { client.end(); settle(resolve, true); }, 10000);
               } else if (restResp.status === 403) {
                  // Renew tokens and retry
                  log('[MQTT] REST 403 -- renewing tokens and retrying', 'warn');
                  await this.ensureTokens(true);
                  restHeaders['e-auth-token'] = this.jwtToken;
                  restHeaders['x-xsrf-token'] = this.xsrfToken;
                  const restResp2 = await this._fetch(batteryUrl, { method: 'PUT', headers: restHeaders, body: payload });
                  const restBody2 = await restResp2.text();
                  if (debug >= 1) log(`[MQTT] REST retry: HTTP ${restResp2.status}`, restResp2.ok ? 'info' : 'warn');
                  if (debug >= 2) log(`[MQTT] REST retry body: ${restBody2}`, 'info');
                  client.end();
                  if (restResp2.ok) settle(resolve, true);
                  else settle(reject, new Error(`REST PUT failed: HTTP ${restResp2.status} -- ${restBody2}`));
               } else {
                  client.end();
                  settle(reject, new Error(`REST PUT failed: HTTP ${restResp.status} -- ${restBody}`));
               }
            } catch (restErr) {
               log(`[MQTT] REST error: ${restErr instanceof Error ? restErr.message : String(restErr)}`, 'warn');
               client.end();
               settle(reject, restErr instanceof Error ? restErr : new Error(String(restErr)));
            }
         });

         client.on('message', (topic, msg) => {
            if (debug >= 2) log(`[MQTT] Server response on ${topic}: ${msg.toString()}`, 'info');
            // On profile_change_response resolve immediately
            try {
               const parsed = JSON.parse(msg.toString());
               if (parsed.messageType === 'profile_change_response' ||
                   parsed.messageType === 'storm_change_response') {
                  if (debug >= 1) log('[MQTT] Change confirmed via MQTT', 'info');
                  client.end();
                  settle(resolve, true);
               }
            } catch (e) { /* not JSON -- ignore */ }
         });

         client.on('error', (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[MQTT] Error: ${msg}`, 'warn');
            settle(reject, new Error(`MQTT connection error: ${msg}`));
         });

         client.on('close', () => {
            if (debug >= 2) log('[MQTT] Connection closed', 'info');
            settle(reject, new Error('MQTT connection closed (before connect)'));
         });

         client.on('offline', () => {
            log('[MQTT] Client offline', 'warn');
         });
      });
   }

   // ------------------------------------------------
   // loadCache / _saveCache: persist tokens to a JSON file on disk
   //
   // loadCache() reads jwt, jwtExp, xsrf, userId, batteryId, and cookies
   //             from CACHE_FILE and populates the instance fields.
   // _saveCache() writes the current state back to CACHE_FILE.
   // ------------------------------------------------
   loadCache() {
      try {
         if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            this.jwtToken  = data.jwt       || null;
            this.jwtExp    = data.jwtExp    || null;
            this.xsrfToken = data.xsrf      || null;
            this.userId    = data.userId    || null;
            this.batteryId = data.batteryId || null;
            if (data.cookies) this.cookieJar.fromJSON(data.cookies);
            if (debug >= 2) log('[Cache] Tokens loaded from file cache', 'info');
         }
      } catch (e) {
         if (debug >= 2) log(`[Cache] Load error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }

   _saveCache() {
      try {
         const dir = path.dirname(CACHE_FILE);
         if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
         fs.writeFileSync(CACHE_FILE, JSON.stringify({
            jwt:       this.jwtToken,
            jwtExp:    this.jwtExp,
            xsrf:      this.xsrfToken,
            userId:    this.userId,
            batteryId: this.batteryId,
            cookies:   this.cookieJar.toJSON(),
         }, null, 2), 'utf8');
         if (debug >= 2) log('[Cache] Tokens saved', 'info');
      } catch (e) {
         if (debug >= 2) log(`[Cache] Save error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }

   // ------------------------------------------------
   // _saveToStates / loadFromStates: persist tokens to ioBroker datapoints
   //
   // _saveToStates() writes jwt_token, jwt_expires, xsrf_token, user_id,
   //                 battery_id, and last_login to ioBroker status states.
   // loadFromStates() reads those values back and populates the instance fields.
   // ------------------------------------------------
   async _saveToStates() {
      try {
         if (this.jwtToken)   setState(dpStatus + 'jwt_token',   this.jwtToken,  true);
         if (this.jwtExp)     setState(dpStatus + 'jwt_expires', new Date(this.jwtExp * 1000).toISOString(), true);
         if (this.xsrfToken)  setState(dpStatus + 'xsrf_token', this.xsrfToken, true);
         if (this.userId)     setState(dpStatus + 'user_id',     this.userId,    true);
         if (this.batteryId)  setState(dpStatus + 'battery_id',  this.batteryId, true);
         setState(dpStatus + 'last_login', new Date().toISOString(), true);
         if (debug >= 2) log('[States] Tokens saved to ioBroker states', 'info');
      } catch (e) {
         if (debug >= 2) log(`[States] Error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }

   loadFromStates() {
      try {
         const readVal = (dp) => { const s = getState(dp); return s ? s.val : null; };
         this.jwtToken  = readVal(dpStatus + 'jwt_token')  || this.jwtToken;
         this.xsrfToken = readVal(dpStatus + 'xsrf_token') || this.xsrfToken;
         this.userId    = readVal(dpStatus + 'user_id')    || this.userId;
         this.batteryId = readVal(dpStatus + 'battery_id') || this.batteryId;
         const expStr   = readVal(dpStatus + 'jwt_expires');
         if (expStr) this.jwtExp = Math.floor(new Date(expStr).getTime() / 1000);
         if (debug >= 2) log('[States] Tokens loaded from ioBroker states', 'info');
      } catch (e) {
         if (debug >= 2) log(`[States] Read error: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }
}

// -------------------------------------------------------------------------------------------------------------------
// Main program
// -------------------------------------------------------------------------------------------------------------------

// Read credentials from ioBroker states
const email    = getState(dpConfig + 'email').val    || '';
const password = getState(dpConfig + 'password').val || '';

if (!email || !password) {
   log('Enphase email and/or password not configured', 'warn');
   log(`  Please set: ${dpConfig}email  and  ${dpConfig}password`, 'warn');
}

// Instantiate client
const enphaseClient = new EnphaseCloudClient(email, password);

// Load tokens from previous run (file cache takes precedence over states)
enphaseClient.loadFromStates();
enphaseClient.loadCache();

// Fix: login() is async -- must be called inside an async IIFE.
// Previously: enphaseClient.login() without await --> Promise ignored, errors swallowed.
// Now: errors are correctly logged, script continues afterwards.
(async () => {
   if (email && password) {
      try {
         if (!enphaseClient.checkToken()) {
            await enphaseClient.login();
         } else {
            if (debug >= 1) log('[Init] Valid token from cache -- no re-login needed', 'info');
         }
         // After login: read current cloud status and synchronize states
         await enphaseClient.readBatteryDischargeStatus();
         await enphaseClient.readChargeFromGrid();
         await enphaseClient.readDischargeSchedules();
         await enphaseClient.readChargeSchedules();
         if (debug >= 1) log('[Init] Startup sync complete', 'info');
      } catch (err) {
         log(`[Init] Startup failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
   }
})();

// -------------------------------------------------------------------------------------------------------------------
// State subscriptions: react to switch changes
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'battery_discharge_restrict', change: 'ne', ack: false }, async (obj) => {
   const enable = !!obj.state.val;
   if (debug >= 1) log(`[Trigger] Restrict battery discharge -> ${enable}`, 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured -- action aborted', 'error');
      return;
   }

   try {
      await enphaseClient.changeBatteryDischargeSwitch(enable);
   } catch (err) {
      log(`[Error] changeBatteryDischargeSwitch: ${err instanceof Error ? err.message : String(err)}`, 'error');
      // Reset state to previous value on error
      setState(dpControl + 'battery_discharge_restrict', !enable, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manual status read via read_battery_status datapoint
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_battery_status', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return; // only trigger on true
   if (debug >= 1) log('[Trigger] Manual battery status read triggered', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured -- action aborted', 'error');
      return;
   }

   try {
      await enphaseClient.readBatteryDischargeStatus();
   } catch (err) {
      log(`[Error] readBatteryDischargeStatus: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_battery_status', false, true); // reset button
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manually fetch grid-charge status
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_charge_from_grid_status', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Manual grid-charge status read triggered', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured -- action aborted', 'error');
      setState(dpControl + 'read_charge_from_grid_status', false, true);
      return;
   }

   try {
      await enphaseClient.readChargeFromGrid();
   } catch (err) {
      log(`[Error] readChargeFromGrid: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_charge_from_grid_status', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: "Charge from Grid" switch
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'battery_charge_from_grid_enable', change: 'ne', ack: false }, async (obj) => {
   const enable = !!obj.state.val;
   if (debug >= 1) log(`[Trigger] Charge from grid -> ${enable}`, 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured -- action aborted', 'error');
      return;
   }

   try {
      await enphaseClient.changeChargeFromGrid(enable);
   } catch (err) {
      log(`[Error] changeChargeFromGrid: ${err instanceof Error ? err.message : String(err)}`, 'error');
      // Reset state to previous value on error
      setState(dpControl + 'battery_charge_from_grid_enable', !enable, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manually read discharge schedules
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Reading discharge schedules from cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'read_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.readDischargeSchedules();
   } catch (err) {
      log(`[Error] readDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_discharge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manually restore discharge schedules
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'restore_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Restoring discharge schedules', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'restore_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.restoreDischargeSchedules();
   } catch (err) {
      log(`[Error] restoreDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'restore_discharge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manually read charge schedules
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Reading charge schedules from cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'read_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.readChargeSchedules();
   } catch (err) {
      log(`[Error] readChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_charge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State subscription: manually restore charge schedules
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'restore_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Restoring charge schedules', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'restore_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.restoreChargeSchedules();
   } catch (err) {
      log(`[Error] restoreChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'restore_charge_schedules', false, true);
   }
});

on({ id: dpControl + 'delete_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Deleting all discharge schedules in cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'delete_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.deleteDischargeSchedules();
   } catch (err) {
      log(`[Error] deleteDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'delete_discharge_schedules', false, true);
   }
});

on({ id: dpControl + 'delete_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Deleting all charge schedules in cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Error] No credentials configured', 'error');
      setState(dpControl + 'delete_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.deleteChargeSchedules();
   } catch (err) {
      log(`[Error] deleteChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'delete_charge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// Auto-acknowledge for schedule datapoints
// When the user manually edits a schedule value in ioBroker admin, the new value is
// immediately confirmed with ack=true. Without this subscription, the ioBroker admin
// frontend keeps showing the last acknowledged value and ignores the unacknowledged change.
// Prefix: dpBase + 'schedules.' covers both schedules.discharge.* and schedules.charge.*
// -------------------------------------------------------------------------------------------------------------------
on({ id: new RegExp('^' + dpBase.replace(/\./g, '\\.') + 'schedules\\.'), change: 'any', ack: false }, (obj) => {
   if (obj.id && obj.state) setState(obj.id, obj.state.val, true);
});

// -------------------------------------------------------------------------------------------------------------------
// Daily token renewal
// -------------------------------------------------------------------------------------------------------------------
schedule('0 3 * * *', async () => {
   if (debug >= 1) log('[Schedule] Daily token check', 'info');
   if (!enphaseClient.checkToken()) {
      try {
         await enphaseClient.login();
      } catch (err) {
         log(`[Schedule] Token renewal failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
   }
});

if (debug >= 1) log('[Init] Enphase Battery Control script started', 'info');
if (debug >= 1) log(`[Init] Control datapoint: ${dpControl}battery_discharge_restrict`, 'info');
