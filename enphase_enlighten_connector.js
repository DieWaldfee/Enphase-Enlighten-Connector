// ioBroker Script: Enphase Battery Control (Session-basierter Login)
// JavaScript-Konvertierung von: https://github.com/chinedu40/hacs_enphase_envoy_cloud
//
// Dieses Script meldet sich per Email/Passwort bei enlighten.enphaseenergy.com an
// und steuert Batterieeinstellungen über die interne Cloud-API.
//
// Enthält: login, getCsrfToken, getJwtToken, updateToken, checkToken,
//          changeBatteryDischargeSwitch ("Batterieentladung einschränken")
//
// Bugfixes gegenüber Vorversion:
//  - login() wird beim Start korrekt mit await aufgerufen (Async-IIFE)
//  - Login-POST verwendet redirect:'manual' damit 302-Cookies nicht verloren gehen
//  - updateToken() loggt Response-Body bei Fehler
//  - Überflüssiger standalone-Aufruf von checkToken() entfernt

'use strict';

const fetch = require('node-fetch');
const fs    = require('fs');
const path  = require('path');
const { URLSearchParams } = require('url');

// --- Modulprüfung ---
if (typeof fetch !== 'function') {
   log('Module node-fetch ist nicht als Funktion geladen - Script gestoppt', 'error');
   stopScript();
   return;
}

// -------------------------------------------------------------------------------------------------------------------
// Konfiguration :: Bitte anpassen
// -------------------------------------------------------------------------------------------------------------------
let debug = 1; // Debug-Level (0=minimal, 1=info, 2=erweitert, 3=vollständig)

const ENLIGHTEN_BASE  = 'https://enlighten.enphaseenergy.com';
const BATTERY_UI_BASE = 'https://battery-profile-ui.enphaseenergy.com';

// Automatische Wiederherstellung nach Aktivierung des RBD-Schalters?
// true = restoreDischargeSchedules() wird nach changeBatteryDischargeSwitch(true) aufgerufen
const AUTO_RESTORE_SCHEDULES = true;

// maxDischargeSchedules / maxChargeSchedules und restoreDelayMs werden aus ioBroker-Config-Datenpunkten gelesen (siehe unten)
let maxDischargeSchedules = 1;     // Standardwert – wird nach DP-Anlage überschrieben
let maxChargeSchedules    = 1;     // Standardwert – wird nach DP-Anlage überschrieben
let restoreDelayMs        = 15000; // Standardwert – wird nach DP-Anlage überschrieben

// ioBroker Datenpfade
const dpBase    = '0_userdata.0.enphase.battery.';
const dpConfig  = dpBase + 'config.';
const dpStatus  = dpBase + 'status.';
const dpControl = dpBase + 'control.';
const dpSchedD  = dpBase + 'schedules.discharge.';
const dpSchedC  = dpBase + 'schedules.charge.';

// Cache-Datei für Token-Persistenz (Pfad anpassen falls nötig)
const CACHE_FILE = path.join('/opt/iobroker/iobroker-data', 'enphase_battery_auth.json');

// -------------------------------------------------------------------------------------------------------------------
// Datenpunkte anlegen
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
   desc: 'Netzlade-Status manuell von Enphase Cloud abrufen' });
await ensureStateAsync(dpControl + 'battery_charge_from_grid_enable',           false,   { type: 'boolean', role: 'switch',    read: true, write: true,
   desc: 'Batterieladen über Stromnetz aktivieren/deaktivieren' });
await ensureStateAsync(dpStatus  + 'charge_from_grid_cloud',     false,   { type: 'boolean', role: 'indicator', read: true, write: false,
   desc: 'Aktueller Cloud-Status: Netzladen' });

await ensureStateAsync(dpStatus  + 'battery_grid_mode',          '',      { type: 'string',  role: 'text',      read: true, write: false,
   desc: 'Aktueller batteryGridMode' });

// Zeitplan-Konfiguration aus ioBroker (Werte werden bei Skriptstart ausgelesen)
await ensureStateAsync(dpConfig + 'max_discharge_schedules', 1,     { type: 'number', role: 'value', read: true, write: true,
   desc: 'Max. Anzahl Entlade-Zeitpläne im ioBroker (Skript neu starten nach Änderung!)' });
await ensureStateAsync(dpConfig + 'max_charge_schedules',    1,     { type: 'number', role: 'value', read: true, write: true,
   desc: 'Max. Anzahl Lade-Zeitpläne im ioBroker (Skript neu starten nach Änderung!)' });
await ensureStateAsync(dpConfig + 'restore_delay_ms',        15000, { type: 'number', role: 'value', read: true, write: true,
   desc: 'Wartezeit in ms vor Zeitplan-Wiederherstellung nach Aktivierung' });

// Konfigurationswerte aus ioBroker auslesen
maxDischargeSchedules = Number(getState(dpConfig + 'max_discharge_schedules').val) || 1;
maxChargeSchedules    = Number(getState(dpConfig + 'max_charge_schedules').val)    || 1;
restoreDelayMs        = Number(getState(dpConfig + 'restore_delay_ms').val)        || 15000;
if (debug >= 1) log(`[Init] Config: max_discharge=${maxDischargeSchedules}, max_charge=${maxChargeSchedules}, restore_delay=${restoreDelayMs}ms`, 'info');

// Zeitplan-Steuerung (Entladung)
await ensureStateAsync(dpControl + 'read_discharge_schedules',    false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'restore_discharge_schedules', false, { type: 'boolean', role: 'button', read: true, write: true });

// Zeitplan-Steuerung (Ladung)
await ensureStateAsync(dpControl + 'read_charge_schedules',       false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'restore_charge_schedules',    false, { type: 'boolean', role: 'button', read: true, write: true });
await ensureStateAsync(dpControl + 'delete_charge_schedules',     false, { type: 'boolean', role: 'button', read: true, write: true,
   desc: 'Alle Lade-Zeitpläne in der Enphase Cloud löschen (Soft-Delete)' });

// Zeitplan-Löschung (Entladung)
await ensureStateAsync(dpControl + 'delete_discharge_schedules',  false, { type: 'boolean', role: 'button', read: true, write: true,
   desc: 'Alle Entlade-Zeitpläne in der Enphase Cloud löschen (Soft-Delete)' });

// Entlade-Zeitplan-Status (schedules.discharge.*)
await ensureStateAsync(dpSchedD + 'count',    0,  { type: 'number', role: 'value', read: true, write: true,
   desc: 'Anzahl gespeicherter Entlade-Zeitpläne' });
await ensureStateAsync(dpSchedD + 'raw_json', '', { type: 'string', role: 'json',  read: true, write: true,
   desc: 'Alle Entlade-Zeitpläne als JSON-Array' });
for (let i = 0; i < maxDischargeSchedules; i++) {
   await ensureStateAsync(dpSchedD + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
   await ensureStateAsync(dpSchedD + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Startzeit als HH:MM (z.B. "00:05")' });
   await ensureStateAsync(dpSchedD + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Endzeit als HH:MM (z.B. "00:10")' });
   await ensureStateAsync(dpSchedD + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
   await ensureStateAsync(dpSchedD + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Wochentage als JSON-Array [1=Mo..7=So]' });
   await ensureStateAsync(dpSchedD + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Zeitplan aktiv (isEnabled)' });
}

// Lade-Zeitplan-Status (schedules.charge.*)
await ensureStateAsync(dpSchedC + 'count',    0,  { type: 'number', role: 'value', read: true, write: true,
   desc: 'Anzahl gespeicherter Lade-Zeitpläne' });
await ensureStateAsync(dpSchedC + 'raw_json', '', { type: 'string', role: 'json',  read: true, write: true,
   desc: 'Alle Lade-Zeitpläne als JSON-Array' });
for (let i = 0; i < maxChargeSchedules; i++) {
   await ensureStateAsync(dpSchedC + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
   await ensureStateAsync(dpSchedC + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Startzeit als HH:MM (z.B. "22:00")' });
   await ensureStateAsync(dpSchedC + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Endzeit als HH:MM (z.B. "06:00")' });
   await ensureStateAsync(dpSchedC + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
   await ensureStateAsync(dpSchedC + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Wochentage als JSON-Array [1=Mo..7=So]' });
   await ensureStateAsync(dpSchedC + `${i}_limit`,    100, { type: 'number',  role: 'value', read: true, write: true, desc: 'Ladelimit in % (0–100), z.B. 100 = vollständig laden' });
   await ensureStateAsync(dpSchedC + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Zeitplan aktiv (isEnabled)' });
}

if (debug >= 1) log('[Init] Datenpunkte geprüft/angelegt', 'info');

// -------------------------------------------------------------------------------------------------------------------
// Cookie-Jar: verwaltet alle Session-Cookies über mehrere HTTP-Requests
// -------------------------------------------------------------------------------------------------------------------
class CookieJar {
   constructor() {
      this._cookies = new Map(); // name -> value
   }

   /**
    * Parst Set-Cookie Header(s) und speichert Cookies.
    * Kompatibel mit node-fetch v2 (headers.raw()) und v3 (getSetCookie()).
    * @param {string|string[]} setCookieHeaders
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
         if (debug >= 3) log(`[Cookie] Gespeichert: ${name}=${value.substring(0, 30)}...`, 'debug');
      }
   }

   /** Gibt den Cookie-Header-String für ausgehende Requests zurück */
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
// EnphaseCloudClient – Hauptklasse für Login und Batteriesteuerung
// -------------------------------------------------------------------------------------------------------------------
class EnphaseCloudClient {
   constructor(email, password) {
      this.email      = email;
      this.password   = password;
      this.jwtToken   = null;  // JWT Bearer Token
      this.jwtExp     = null;  // JWT Ablaufzeit (Unix-Sekunden)
      this.xsrfToken  = null;  // BP-XSRF-Token
      this.userId       = null;  // Numerische User-ID
      this.batteryId    = null;  // Numerische Site/Battery-ID
      this.supportsMqtt = null;  // null = unbekannt, true/false nach erstem readBatteryDischargeStatus()
      this.cookieJar    = new CookieJar();
   }

   // ------------------------------------------------
   // HTTP-Request mit Cookie-Jar
   // Wichtig: Cookies aus Set-Cookie-Headern werden automatisch gespeichert.
   // Bei redirect:'manual' werden auch 302-Cookies korrekt erfasst.
   // ------------------------------------------------
   async _fetch(url, options = {}) {
      options.headers = options.headers || {};

      // Vorhandene Cookies anhängen (mit bestehendem Cookie-Header zusammenführen)
      const cookieStr = this.cookieJar.getCookieHeader();
      if (cookieStr) {
         const existing = options.headers['Cookie'] || options.headers['cookie'] || '';
         options.headers['Cookie'] = existing ? `${existing}; ${cookieStr}` : cookieStr;
      }

      if (debug >= 3) log(`[HTTP] ${options.method || 'GET'} ${url}`, 'debug');

      const response = await fetch(url, options);

      // Set-Cookie aus Antwort speichern – kompatibel mit node-fetch v2 und v3
      let setCookies = null;
      if (response.headers && typeof response.headers.raw === 'function') {
         setCookies = response.headers.raw()['set-cookie']; // node-fetch v2: Array
      } else if (response.headers && typeof response.headers.getSetCookie === 'function') {
         setCookies = response.headers.getSetCookie();       // node-fetch v3 / native fetch
      } else {
         const single = response.headers.get('set-cookie');
         if (single) setCookies = [single];
      }
      if (setCookies && setCookies.length > 0) {
         this.cookieJar.parseAndStore(setCookies);
      }

      if (debug >= 3) log(`[HTTP] Antwort: ${response.status} ${response.statusText}`, 'debug');
      return response;
   }

   // ------------------------------------------------
   // JWT-Payload Base64url-dekodieren
   // ------------------------------------------------
   _jwtPayload(jwt) {
      try {
         const parts = jwt.split('.');
         if (parts.length < 2) return null;
         const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
         return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } catch (e) {
         if (debug >= 1) log(`[JWT] Payload-Dekodierung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`, 'warn');
         return null;
      }
   }

   // ------------------------------------------------
   // checkToken: Prüft ob der JWT noch mind. 1 Stunde gültig ist
   // ------------------------------------------------
   checkToken() {
      if (!this.jwtToken) {
         if (debug >= 2) log('[checkToken] Kein JWT Token vorhanden', 'info');
         return false;
      }
      const exp = this.jwtExp;
      if (!exp || typeof exp !== 'number') {
         if (debug >= 2) log('[checkToken] JWT Ablaufzeit nicht bekannt', 'info');
         return false;
      }
      const nowSec    = Math.floor(Date.now() / 1000);
      const valid     = exp > (nowSec + 3600); // 1 Stunde Puffer
      if (debug >= 1) {
         const remainMin = Math.round((exp - nowSec) / 60);
         log(`[checkToken] JWT läuft in ${remainMin} Minuten ab – gültig: ${valid}`, 'info');
      }
      return valid;
   }

   // ------------------------------------------------
   // getCsrfToken: authenticity_token von der Login-Seite holen
   // ------------------------------------------------
   async getCsrfToken() {
      if (debug >= 1) log('[getCsrfToken] Lade Enphase Login-Seite', 'info');

      const response = await this._fetch(`${ENLIGHTEN_BASE}/login`);
      if (!response.ok) {
         throw new Error(`Login-Seite nicht erreichbar: HTTP ${response.status}`);
      }

      const html  = await response.text();
      const match = html.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/);
      if (!match) {
         throw new Error('authenticity_token nicht auf der Login-Seite gefunden');
      }

      const token = match[1];
      if (debug >= 2) log(`[getCsrfToken] CSRF Token: ${token.substring(0, 20)}...`, 'info');
      return token;
   }

   // ------------------------------------------------
   // getJwtToken: JWT Token nach erfolgreichem Login abrufen
   //
   // Primär: GET /app-api/jwt_token.json (Python-Projekt, bewährt)
   // Fallback: GET /service/auth_ms_enho/api/v1/session/token (HAR-Analyse, Browser)
   // ------------------------------------------------
   async getJwtToken() {
      if (debug >= 1) log('[getJwtToken] Rufe JWT Token ab', 'info');

      // --- Primärer Weg: /app-api/jwt_token.json (Python-Projekt) ---
      let token = null;
      try {
         const resp = await this._fetch(`${ENLIGHTEN_BASE}/app-api/jwt_token.json`);
         if (resp.ok) {
            const data = await resp.json();
            token = data.token || null;
            if (token && debug >= 1) log('[getJwtToken] JWT via jwt_token.json erhalten', 'info');
         } else if (debug >= 1) {
            log(`[getJwtToken] jwt_token.json HTTP ${resp.status} – versuche Fallback`, 'warn');
         }
      } catch (e) {
         if (debug >= 1) log(`[getJwtToken] jwt_token.json Fehler: ${e instanceof Error ? e.message : String(e)} – versuche Fallback`, 'warn');
      }

      // --- Fallback: auth_ms_enho (Browser-Weg aus HAR) ---
      if (!token) {
         const sessionHex = this.cookieJar.get('_enlighten_4_session');
         if (!sessionHex) {
            throw new Error('_enlighten_4_session Cookie fehlt und jwt_token.json schlug fehl');
         }
         const response = await this._fetch(`${ENLIGHTEN_BASE}/service/auth_ms_enho/api/v1/session/token`, {
            headers: {
               'e-auth-token':     sessionHex,
               'X-Requested-With': 'XMLHttpRequest',
            },
         });
         if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`JWT Abruf fehlgeschlagen: HTTP ${response.status} – ${errorBody}`);
         }
         const data = await response.json();
         token = data.token || null;
         if (!token) throw new Error('JWT Token nicht in der Server-Antwort enthalten');
         if (debug >= 1) log('[getJwtToken] JWT via auth_ms_enho erhalten', 'info');
      }

      this.jwtToken = token;
      const payload = this._jwtPayload(token);
      this.jwtExp   = (payload && typeof payload.exp === 'number') ? payload.exp : null;

      if (debug >= 1) {
         const expStr = this.jwtExp ? new Date(this.jwtExp * 1000).toISOString() : 'unbekannt';
         log(`[getJwtToken] JWT gültig bis: ${expStr}`, 'info');
      }
      return token;
   }

   // ------------------------------------------------
   // _discoverIds: user_id und battery_id automatisch ermitteln
   // ------------------------------------------------
   async _discoverIds() {
      if (debug >= 1) log('[discoverIds] Ermittle User-ID und Battery-ID', 'info');

      const homeResp = await this._fetch(`${ENLIGHTEN_BASE}/`, { redirect: 'follow' });
      const finalUrl = homeResp.url;
      if (debug >= 2) log(`[discoverIds] Finale URL: ${finalUrl}`, 'info');

      const siteMatch = finalUrl.match(/\/(web|pv\/systems|systems)\/([0-9]+)/);
      if (!siteMatch) {
         throw new Error(`Konnte Site-ID nicht aus Redirect-URL ermitteln: ${finalUrl}`);
      }
      const siteId = siteMatch[2];

      const appUrl  = `${ENLIGHTEN_BASE}/app-api/${siteId}/data.json?app=1&device_status=non_retired&is_mobile=0`;
      const appResp = await this._fetch(appUrl);
      if (!appResp.ok) {
         throw new Error(`App-Daten Abruf fehlgeschlagen: HTTP ${appResp.status}`);
      }

      const appData  = await appResp.json();
      const appBlock = appData.app || {};
      const userId   = appBlock.userId
                    || appBlock.user_id
                    || (appBlock.user && appBlock.user.id);

      if (!userId || !/^\d+$/.test(String(userId))) {
         throw new Error('Konnte numerische User-ID nicht aus App-Daten ermitteln');
      }

      if (!this.batteryId) this.batteryId = String(siteId);
      if (!this.userId)    this.userId    = String(userId);

      if (debug >= 1) log(`[discoverIds] userId=${this.userId}, batteryId=${this.batteryId}`, 'info');
   }

   // ------------------------------------------------
   // updateToken: BP-XSRF-Token erneuern
   // ------------------------------------------------
   async updateToken() {
      if (debug >= 1) log('[updateToken] Aktualisiere BP-XSRF-Token', 'info');

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

      // BP-XSRF-Token aus dem Cookie-Jar (wurde von _fetch automatisch gespeichert)
      let xsrfToken = this.cookieJar.get('BP-XSRF-Token');

      // Fallback: manuell aus dem Set-Cookie Header extrahieren
      if (!xsrfToken) {
         const setCookie = response.headers.get('set-cookie') || '';
         const match     = setCookie.match(/BP-XSRF-Token=([^;]+)/);
         if (match) {
            xsrfToken = match[1];
            this.cookieJar.set('BP-XSRF-Token', xsrfToken);
         }
      }

      if (!xsrfToken) {
         // Response-Body loggen für Diagnose
         const body = await response.text().catch(() => '(kein Body)');
         throw new Error(`BP-XSRF-Token nicht erhalten (HTTP ${response.status}): ${body}`);
      }

      this.xsrfToken = xsrfToken;
      if (debug >= 1) log(`[updateToken] XSRF Token erhalten: ${xsrfToken.substring(0, 15)}...`, 'info');
      return xsrfToken;
   }

   // ------------------------------------------------
   // login: Vollständiger Login-Ablauf
   //
   // FIX: Login-POST verwendet redirect:'manual' damit die 302-Antwort
   // mit dem Session-Cookie (_enlighten_session) korrekt erfasst wird.
   // Bei fetch(redirect:'follow') gehen Cookies aus Intermediate-Redirects verloren,
   // was dazu führt dass updateToken() keine gültige Session vorfindet
   // und den BP-XSRF-Token nicht erhält.
   // ------------------------------------------------
   async login() {
      if (debug >= 0) log('[login] Starte Enphase Login', 'info');

      if (!this.email || !this.password) {
         throw new Error('Email und Passwort sind für den Login erforderlich');
      }

      // Cookies löschen für sauberen Login-Start
      this.cookieJar.clear();

      // Schritt 1: CSRF Token holen
      const authenticityToken = await this.getCsrfToken();

      // Schritt 2: Login POST mit redirect:'manual'
      // WICHTIG: 'manual' statt 'follow' – nur so werden die Cookies der 302-Antwort
      // (insbesondere der Session-Cookie _enlighten_session) vom Cookie-Jar erfasst.
      const loginPayload = new URLSearchParams({
         'utf8':               '✓',
         'authenticity_token': authenticityToken,
         'user[email]':        this.email,
         'user[password]':     this.password,
      });

      if (debug >= 2) log('[login] Sende Login-Credentials (redirect:manual)', 'info');
      const loginResp = await this._fetch(`${ENLIGHTEN_BASE}/login/login`, {
         method:   'POST',
         headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
         body:     loginPayload.toString(),
         redirect: 'manual', // ← FIX: 302-Cookies werden jetzt von _fetch erfasst
      });

      if (debug >= 2) log(`[login] Login POST Antwort: HTTP ${loginResp.status}`, 'info');

      // Erwartete Antworten: 302 (Redirect nach Erfolg) oder 200/303
      // Alles ausser 4xx/5xx ist akzeptabel
      if (loginResp.status >= 400) {
         const loginBody = await loginResp.text().catch(() => '');
         throw new Error(`Login POST fehlgeschlagen: HTTP ${loginResp.status} – ${loginBody}`);
      }

      // Manuell dem Redirect folgen (Cookies aus 302 sind jetzt im Cookie-Jar)
      const location = loginResp.headers.get('location');
      if (location) {
         const redirectUrl = location.startsWith('http') ? location : `${ENLIGHTEN_BASE}${location}`;
         if (debug >= 2) log(`[login] Folge Redirect zu: ${redirectUrl}`, 'info');
         await this._fetch(redirectUrl, { redirect: 'follow' });
      }

      if (debug >= 1) log('[login] Login erfolgreich, Session-Cookie gespeichert', 'info');

      // Schritt 3: JWT Token abrufen
      await this.getJwtToken();

      // Schritt 4: User/Battery-IDs ermitteln
      await this._discoverIds();

      // Schritt 5: XSRF Token holen
      await this.updateToken();

      // Schritt 6: Persistenz
      await this._saveToStates();
      this._saveCache();

      if (debug >= 0) log('[login] Login vollständig abgeschlossen ✓', 'info');
   }

   // ------------------------------------------------
   // ensureTokens: Tokens sicherstellen – Login wenn nötig
   // ------------------------------------------------
   async ensureTokens(forceRefresh = false) {
      if (forceRefresh || !this.checkToken()) {
         if (debug >= 1) log('[ensureTokens] Token abgelaufen/fehlend – starte Neulogin', 'info');
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
   // changeBatteryDischargeSwitch: "Batterieentladung einschränken" (RBD-Modus)
   //   Einstellungen > Speicher > Batterieentladung einschränken
   // @param {boolean} enable  true = einschränken aktiv
   // ------------------------------------------------
   async changeBatteryDischargeSwitch(enable) {
      log(`[Battery] ▶ changeBatteryDischargeSwitch aufgerufen: enable=${enable}`, 'info');

      // --- Schritt 1: Tokens sicherstellen ---
      log('[Battery] Schritt 1: Prüfe/hole Tokens (ensureTokens)', 'info');
      await this.ensureTokens();
      log(`[Battery] Tokens OK – userId=${this.userId}, batteryId=${this.batteryId}`, 'info');
      log(`[Battery] jwtToken=${this.jwtToken ? this.jwtToken.substring(0, 30) + '...' : 'NULL'}`, 'info');
      log(`[Battery] xsrfToken=${this.xsrfToken ? this.xsrfToken.substring(0, 20) + '...' : 'NULL'}`, 'info');
      log(`[Battery] Cookies im Jar: ${this.cookieJar.getCookieHeader().replace(/=[^;]{10,}/g, '=***')}`, 'info');

      // --- Schritt 2: Pfad wählen (MQTT für supportsMqtt:true, REST als Fallback) ---
      log(`[Battery] Schritt 2: supportsMqtt=${this.supportsMqtt}`, 'info');

      if (this.supportsMqtt === true) {
         // MQTT-Pfad: REST-PUT wird vom Server ignoriert (gibt zwar "success" zurück,
         // ändert aber nichts) → Einstellung per MQTT an das Gerät senden
         log('[Battery] Schritt 3: MQTT-Pfad (supportsMqtt=true)', 'info');
         const mqttInfo = await this.getMqttSignedUrl();
         await this.changeBatteryViaMqtt(enable, mqttInfo);
      } else {
         // REST-Pfad: für ältere Systeme ohne MQTT
         log('[Battery] Schritt 3: REST-Pfad (supportsMqtt=false/unbekannt)', 'info');
         const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?userId=${this.userId}&source=enho`;
         const payload = JSON.stringify({ rbdControl: { enabled: enable } });
         log(`[Battery] PUT ${url}`, 'info');
         log(`[Battery] Payload=${payload}`, 'info');

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
         log(`[Battery] REST Antwort: HTTP ${response.status} – ${body1}`, response.ok ? 'info' : 'warn');

         if (response.status === 403) {
            log('[Battery] 403 – hole neue Tokens und wiederhole', 'warn');
            await this.ensureTokens(true);
            headers['e-auth-token'] = this.jwtToken;
            headers['x-xsrf-token'] = this.xsrfToken;
            response = await this._fetch(url, { method: 'PUT', headers, body: payload });
            const body2 = await response.text();
            log(`[Battery] REST Wiederholung: HTTP ${response.status} – ${body2}`, response.ok ? 'info' : 'warn');
            if (!response.ok) throw new Error(`changeBatteryDischargeSwitch fehlgeschlagen: HTTP ${response.status} – ${body2}`);
         } else if (!response.ok) {
            throw new Error(`changeBatteryDischargeSwitch fehlgeschlagen: HTTP ${response.status} – ${body1}`);
         }
      }

      // --- Schritt 4: State aktualisieren ---
      setState(dpControl + 'battery_discharge_restrict', enable, true);
      setState(dpStatus  + 'battery_discharge_cloud',    enable, true);
      log(`[Battery] ✓ "Batterieentladung einschränken" erfolgreich auf ${enable} gesetzt`, 'info');

      // --- Schritt 5: Zeitpläne automatisch wiederherstellen (falls konfiguriert) ---
      if (enable && AUTO_RESTORE_SCHEDULES) {
         const storedRaw = getState(dpSchedD + 'raw_json').val;
         const hasStored = storedRaw && storedRaw !== '[]' && storedRaw !== '';
         if (hasStored) {
            log(`[Battery] Auto-Restore: warte ${restoreDelayMs}ms, dann stelle Zeitpläne wieder her...`, 'info');
            setTimeout(async () => {
               try {
                  await enphaseClient.restoreDischargeSchedules();
               } catch (err) {
                  log(`[Battery] Auto-Restore Zeitpläne fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, 'warn');
               }
            }, restoreDelayMs);
         } else {
            log('[Battery] Auto-Restore: keine gespeicherten Entlade-Zeitpläne vorhanden (zuerst "read_discharge_schedules" ausführen)', 'info');
         }
      }

      return true;
   }

   // ------------------------------------------------
   // readBatteryDischargeStatus: Aktuellen RBD-Status von Enphase Cloud lesen
   //   Liest rbdControl.enabled aus GET /batterySettings
   // @returns {boolean} true = Einschränkung aktiv
   // ------------------------------------------------
   async readBatteryDischargeStatus() {
      log('[BatteryRead] ▶ Lese aktuellen "Batterieentladung einschränken" Status', 'info');

      // Tokens sicherstellen
      await this.ensureTokens();
      log(`[BatteryRead] userId=${this.userId}, batteryId=${this.batteryId}`, 'info');

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?source=enho&userId=${this.userId}`;
      log(`[BatteryRead] GET ${url}`, 'info');

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
         throw new Error(`readBatteryDischargeStatus fehlgeschlagen: HTTP ${response.status} – ${body}`);
      }

      let data;
      const rawText = await response.text();
      log(`[BatteryRead] HTTP ${response.status} – Rohantwort: ${rawText}`, 'info');
      try {
         data = JSON.parse(rawText);
      } catch (e) {
         throw new Error(`readBatteryDischargeStatus: Antwort ist kein gültiges JSON – ${rawText.substring(0, 200)}`);
      }

      // Top-Level-Schlüssel ausgeben, um die Struktur zu verstehen
      log(`[BatteryRead] Top-Level-Keys: ${Object.keys(data).join(', ')}`, 'info');

      // Antwortstruktur: { type, timestamp, data: { rbdControl, supportsMqtt, ... } }
      const settings   = data.data || data.batterySettings || data.settings || data;
      const rbdControl = settings.rbdControl;
      const rbdEnabled = rbdControl && typeof rbdControl.enabled === 'boolean'
         ? rbdControl.enabled
         : null;

      if (rbdEnabled === null) {
         log(`[BatteryRead] rbdControl.enabled nicht gefunden – rbdControl=${JSON.stringify(rbdControl)}`, 'warn');
      } else {
         log(`[BatteryRead] rbdControl.enabled = ${rbdEnabled}`, 'info');
      }

      // supportsMqtt merken für changeBatteryDischargeSwitch()
      if (typeof settings.supportsMqtt === 'boolean') this.supportsMqtt = settings.supportsMqtt;
      log(`[BatteryRead] supportsMqtt=${settings.supportsMqtt}`, 'info');
      log(`[BatteryRead] requestedConfig=${JSON.stringify(settings.requestedConfig)}`, 'info');
      log(`[BatteryRead] requestedConfigMqtt=${JSON.stringify(settings.requestedConfigMqtt)}`, 'info');

      // States aktualisieren
      if (rbdEnabled !== null) {
         setState(dpStatus  + 'battery_discharge_cloud',    rbdEnabled, true);
         setState(dpControl + 'battery_discharge_restrict', rbdEnabled, true);
         log(`[BatteryRead] ✓ battery_discharge_restrict = ${rbdEnabled}`, 'info');
      }

      return rbdEnabled;
   }

   // ------------------------------------------------
   // readChargeFromGrid: "Laden über Stromnetz"-Status von Enphase Cloud lesen
   //   Liest chargingFromGridEnabled (oder gridCharging.enabled) aus GET /batterySettings
   //   und speichert den Wert in dpStatus+'charge_from_grid_cloud' und
   //   dpControl+'battery_charge_from_grid_enable'.
   // @returns {boolean|null}  true = Netzladen aktiv, null = Feld nicht gefunden
   // ------------------------------------------------
   async readChargeFromGrid() {
      log('[GridCharge] ▶ Lese "Laden über Stromnetz" Status von Enphase Cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?source=enho&userId=${this.userId}`;
      log(`[GridCharge] GET ${url}`, 'info');

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
         throw new Error(`readChargeFromGrid fehlgeschlagen: HTTP ${response.status} – ${body}`);
      }

      const rawText = await response.text();
      let data;
      try {
         data = JSON.parse(rawText);
      } catch (e) {
         throw new Error(`readChargeFromGrid: kein gültiges JSON – ${rawText.substring(0, 200)}`);
      }

      // Antwortstruktur: { type, timestamp, data: { ... } }
      const settings = data.data || data.batterySettings || data.settings || data;

      // --- Netzladen aktiv/inaktiv (chargeFromGrid) ---
      const gridChargeEnabled = typeof settings.chargeFromGrid === 'boolean' ? settings.chargeFromGrid : null;
      if (gridChargeEnabled === null) {
         log(`[GridCharge] ⚠ Feld 'chargeFromGrid' nicht gefunden – Keys: ${Object.keys(settings).join(', ')}`, 'warn');
      } else {
         setState(dpStatus  + 'charge_from_grid_cloud', gridChargeEnabled, true);
         setState(dpControl + 'battery_charge_from_grid_enable',       gridChargeEnabled, true);
         log(`[GridCharge] chargeFromGrid = ${gridChargeEnabled}`, 'info');
      }

      // --- Zusätzliche Statusfelder (informativ) ---
      const gridMode = typeof settings.batteryGridMode === 'string' ? settings.batteryGridMode : '';
      if (gridMode) {
         setState(dpStatus + 'battery_grid_mode', gridMode, true);
         log(`[GridCharge] batteryGridMode = ${gridMode}`, 'info');
      }
      if (debug >= 2) {
         log(`[GridCharge] chargeFromGridScheduleEnabled=${settings.chargeFromGridScheduleEnabled}`, 'info');
         log(`[GridCharge] chargeBeginTime=${settings.chargeBeginTime}, chargeEndTime=${settings.chargeEndTime}`, 'info');
      }

      log(`[GridCharge] ✓ Netzlade-Status gespeichert`, 'info');
      return gridChargeEnabled;
   }

   // ------------------------------------------------
   // changeChargeFromGrid: "Laden über Stromnetz" aktivieren/deaktivieren
   //   Setzt chargingFromGridEnabled per PUT /batterySettings
   // @param {boolean} enable  true = Netzladen aktiv
   // ------------------------------------------------
   async changeChargeFromGrid(enable) {
      log(`[GridCharge] ▶ changeChargeFromGrid aufgerufen: enable=${enable}`, 'info');
      await this.ensureTokens();
      log(`[GridCharge] Tokens OK – userId=${this.userId}, batteryId=${this.batteryId}`, 'info');

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
      log(`[GridCharge] PUT ${url}`, 'info');
      log(`[GridCharge] Payload: ${payload}`, 'info');

      let response = await this._fetch(url, { method: 'PUT', headers, body: payload });
      const body1  = await response.text();
      log(`[GridCharge] Antwort: HTTP ${response.status} – ${body1}`, response.ok ? 'info' : 'warn');

      if (response.status === 403) {
         log('[GridCharge] 403 – hole neue Tokens und wiederhole', 'warn');
         await this.ensureTokens(true);
         headers['e-auth-token'] = this.jwtToken;
         headers['x-xsrf-token'] = this.xsrfToken;
         response = await this._fetch(url, { method: 'PUT', headers, body: payload });
         const body2 = await response.text();
         log(`[GridCharge] Wiederholung: HTTP ${response.status} – ${body2}`, response.ok ? 'info' : 'warn');
         if (!response.ok) throw new Error(`changeChargeFromGrid fehlgeschlagen: HTTP ${response.status} – ${body2}`);
      } else if (!response.ok) {
         throw new Error(`changeChargeFromGrid fehlgeschlagen: HTTP ${response.status} – ${body1}`);
      }

      setState(dpStatus  + 'charge_from_grid_cloud', enable, true);
      setState(dpControl + 'battery_charge_from_grid_enable',       enable, true);
      log(`[GridCharge] ✓ "Laden über Stromnetz" erfolgreich auf ${enable} gesetzt`, 'info');
      return true;
   }

   // ------------------------------------------------
   // readDischargeSchedules: RBD-Zeitpläne auslesen und im ioBroker speichern
   // API: GET /service/batteryConfig/api/v1/battery/sites/{siteId}/schedules
   // Nur Zeitpläne mit scheduleType="RBD" werden gespeichert.
   // Bei mehr Zeitplänen als maxDischargeSchedules → Warnung + Konfiguration anpassen.
   // @returns {Array} gefundene RBD-Zeitpläne
   // ------------------------------------------------
   async readDischargeSchedules() {
      log('[SchedD] ▶ Lese RBD-Zeitpläne von Enphase Cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;
      log(`[SchedD] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`readDischargeSchedules fehlgeschlagen: HTTP ${response.status} – ${text}`);

      // API-Antwortstruktur: { type:"BATTERY_SCHEDULES_CONFIG", rbd:{count:N, details:[...]}, cfg:{...}, dtg:{...} }
      // RBD-Zeitpläne liegen unter parsed.rbd.details
      let rbdSchedules;
      try {
         const parsed = JSON.parse(text);
         log(`[SchedD] Antwort-Typ: ${parsed.type}, rbd.count=${parsed.rbd?.count ?? 'n/a'}`, 'info');
         rbdSchedules = (parsed.rbd && Array.isArray(parsed.rbd.details))
            ? parsed.rbd.details.filter(s => !s.isDeleted)
            : [];
      } catch (e) {
         throw new Error(`readDischargeSchedules: kein gültiges JSON – ${text.substring(0, 200)}`);
      }

      const storeCount = rbdSchedules.length;
      log(`[SchedD] ${storeCount} aktive RBD-Zeitplan(e) gefunden`, 'info');

      // Keine Zeitpläne bei Enphase → ioBroker-Konfiguration unverändert lassen
      if (storeCount === 0) {
         log('[SchedD] ℹ Enphase meldet 0 Zeitpläne – gespeicherte ioBroker-Konfiguration bleibt erhalten', 'info');
         return rbdSchedules;
      }

      // Mehr Zeitpläne als konfiguriert → max_rbd_schedules erhöhen + fehlende DPs anlegen
      if (storeCount > maxDischargeSchedules) {
         log(`[SchedD] ℹ ${storeCount} Entlade-Zeitpläne gefunden, max_discharge_schedules=${maxDischargeSchedules} – passe automatisch an`, 'info');
         const oldMax = maxDischargeSchedules;
         maxDischargeSchedules = storeCount;
         setState(dpConfig + 'max_discharge_schedules', storeCount, true);
         log(`[SchedD] ✓ config.max_discharge_schedules auf ${storeCount} gesetzt`, 'info');
         // Fehlende Datenpunkte für neue Slots anlegen
         for (let i = oldMax; i < storeCount; i++) {
            await ensureStateAsync(dpSchedD + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
            await ensureStateAsync(dpSchedD + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Startzeit als HH:MM' });
            await ensureStateAsync(dpSchedD + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Endzeit als HH:MM' });
            await ensureStateAsync(dpSchedD + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
            await ensureStateAsync(dpSchedD + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Wochentage [1=Mo..7=So]' });
            await ensureStateAsync(dpSchedD + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Zeitplan aktiv (isEnabled)' });
            log(`[SchedD] ✓ Datenpunkte für Slot ${i} angelegt`, 'info');
         }
      }

      // Im ioBroker speichern (nur wenn Zeitpläne vorhanden)
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
      }

      log(`[SchedD] ✓ ${Math.min(storeCount, maxDischargeSchedules)} RBD-Zeitplan(e) im ioBroker gespeichert`, 'info');
      if (debug >= 1) rbdSchedules.slice(0, maxDischargeSchedules).forEach((s, i) =>
         log(`[SchedD]   [${i}] ${s.startTime}-${s.endTime} ${JSON.stringify(s.days)} (${s.scheduleId})`, 'info')
      );
      return rbdSchedules;
   }

   // ------------------------------------------------
   // restoreDischargeSchedules: fehlende RBD-Zeitpläne aus ioBroker wiederherstellen
   // Vergleicht aktuelle Cloud-Zeitpläne mit gespeicherten Werten.
   // Fehlende werden per POST neu angelegt.
   // Sinnvoll nach changeBatteryDischargeSwitch(true), da der Server Zeitpläne löschen kann.
   // ------------------------------------------------
   async restoreDischargeSchedules() {
      log('[SchedD] ▶ Stelle RBD-Zeitpläne wieder her (Delete-all → Create-all)', 'info');
      await this.ensureTokens();

      // Gespeicherte Zeitpläne aus ioBroker laden
      const storedRaw = getState(dpSchedD + 'raw_json').val;
      let storedSchedules = [];
      try { storedSchedules = JSON.parse(storedRaw || '[]'); } catch (e) { /* ignore */ }

      if (!storedSchedules || storedSchedules.length === 0) {
         log('[SchedD] ⚠ Keine gespeicherten Entlade-Zeitpläne vorhanden – zuerst "read_discharge_schedules" ausführen!', 'warn');
         return;
      }
      log(`[SchedD] ${storedSchedules.length} gespeicherte(r) Entlade-Zeitplan(e) werden wiederhergestellt`, 'info');

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      // Schritt 1: Aktuelle Cloud-Zeitpläne lesen und alle soft-löschen
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
         log(`[SchedD] DELETE (soft) ${s.scheduleId} – ${s.startTime}-${s.endTime}`, 'info');
         const delResp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(delPayload),
         });
         const delText = await delResp.text();
         if (delResp.ok) { deleted++; }
         else { log(`[SchedD] ⚠ Soft-Delete fehlgeschlagen (HTTP ${delResp.status}): ${delText}`, 'warn'); }
      }
      log(`[SchedD] ${deleted}/${currentSchedules.length} Zeitplan(e) gelöscht`, 'info');

      // Schritt 2: Alle gespeicherten Zeitpläne neu anlegen
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

         log(`[SchedD] POST – ${payload.startTime}-${payload.endTime} ${JSON.stringify(payload.days)}`, 'info');
         const resp = await this._fetch(schedUrl, {
            method:  'POST',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const respText = await resp.text();
         if (resp.ok) {
            log(`[SchedD] ✓ Zeitplan angelegt (HTTP ${resp.status}): ${respText.substring(0, 100)}`, 'info');
            restored++;
         } else {
            log(`[SchedD] ⚠ Fehler bei Zeitplan ${payload.startTime}-${payload.endTime}: HTTP ${resp.status} – ${respText}`, 'warn');
         }
      }

      log(`[SchedD] ✓ Wiederherstellung: ${restored}/${storedSchedules.length} Zeitplan(e) angelegt`, 'info');

      // Aktualisierten Stand speichern
      if (restored > 0) await this.readDischargeSchedules();
   }

   // ------------------------------------------------
   // readChargeSchedules: Lade-Zeitpläne (CFG) von Enphase Cloud auslesen und im ioBroker speichern
   // Verwendet denselben Schedules-Endpunkt wie readDischargeSchedules.
   // Lade-Zeitpläne liegen unter parsed.cfg.details (scheduleType="CFG" oder ähnlich).
   // @returns {Array} gefundene Lade-Zeitpläne
   // ------------------------------------------------
   async readChargeSchedules() {
      log('[SchedC] ▶ Lese Lade-Zeitpläne von Enphase Cloud', 'info');
      await this.ensureTokens();

      const url = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;
      log(`[SchedC] GET ${url}`, 'info');

      const response = await this._fetch(url, {
         headers: {
            'e-auth-token': this.jwtToken,
            'username':     String(this.userId),
            'origin':       BATTERY_UI_BASE,
            'referer':      BATTERY_UI_BASE + '/',
         },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`readChargeSchedules fehlgeschlagen: HTTP ${response.status} – ${text}`);

      // API-Antwortstruktur: { type:"BATTERY_SCHEDULES_CONFIG", rbd:{...}, cfg:{count:N, details:[...]}, dtg:{...} }
      // Lade-Zeitpläne liegen unter parsed.cfg.details
      let cfgSchedules;
      try {
         const parsed = JSON.parse(text);
         log(`[SchedC] Antwort-Typ: ${parsed.type}, cfg.count=${parsed.cfg?.count ?? 'n/a'}, dtg.count=${parsed.dtg?.count ?? 'n/a'}`, 'info');
         if (debug >= 2) log(`[SchedC] Vollständige Antwort: ${text}`, 'info');
         cfgSchedules = (parsed.cfg && Array.isArray(parsed.cfg.details))
            ? parsed.cfg.details.filter(s => !s.isDeleted)
            : [];
         if (cfgSchedules.length === 0 && parsed.dtg && Array.isArray(parsed.dtg.details)) {
            // Fallback: dtg-Sektion prüfen falls cfg leer ist
            log('[SchedC] cfg leer – prüfe dtg-Sektion als Fallback', 'info');
            cfgSchedules = parsed.dtg.details.filter(s => !s.isDeleted);
         }
      } catch (e) {
         throw new Error(`readChargeSchedules: kein gültiges JSON – ${text.substring(0, 200)}`);
      }

      const storeCount = cfgSchedules.length;
      log(`[SchedC] ${storeCount} aktive Lade-Zeitplan(e) gefunden`, 'info');

      // Keine Zeitpläne bei Enphase → ioBroker-Konfiguration unverändert lassen
      if (storeCount === 0) {
         log('[SchedC] ℹ Enphase meldet 0 Lade-Zeitpläne – gespeicherte ioBroker-Konfiguration bleibt erhalten', 'info');
         return cfgSchedules;
      }

      // Mehr Zeitpläne als konfiguriert → max_charge_schedules erhöhen + fehlende DPs anlegen
      if (storeCount > maxChargeSchedules) {
         log(`[SchedC] ℹ ${storeCount} Lade-Zeitpläne gefunden, max_charge_schedules=${maxChargeSchedules} – passe automatisch an`, 'info');
         const oldMax = maxChargeSchedules;
         maxChargeSchedules = storeCount;
         setState(dpConfig + 'max_charge_schedules', storeCount, true);
         log(`[SchedC] ✓ config.max_charge_schedules auf ${storeCount} gesetzt`, 'info');
         for (let i = oldMax; i < storeCount; i++) {
            await ensureStateAsync(dpSchedC + `${i}_json`,      '', { type: 'string',  role: 'json',  read: true, write: true });
            await ensureStateAsync(dpSchedC + `${i}_startTime`, '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Startzeit als HH:MM' });
            await ensureStateAsync(dpSchedC + `${i}_endTime`,   '', { type: 'string',  role: 'text',  read: true, write: true, desc: 'Endzeit als HH:MM' });
            await ensureStateAsync(dpSchedC + `${i}_timezone`,  '', { type: 'string',  role: 'text',  read: true, write: true });
            await ensureStateAsync(dpSchedC + `${i}_days`,      '', { type: 'string',  role: 'json',  read: true, write: true, desc: 'Wochentage [1=Mo..7=So]' });
            await ensureStateAsync(dpSchedC + `${i}_limit`,    100, { type: 'number',  role: 'value', read: true, write: true, desc: 'Ladelimit in % (0–100)' });
            await ensureStateAsync(dpSchedC + `${i}_enabled`, true, { type: 'boolean', role: 'indicator', read: true, write: true, desc: 'Zeitplan aktiv (isEnabled)' });
            log(`[SchedC] ✓ Datenpunkte für Slot ${i} angelegt`, 'info');
         }
      }

      // Im ioBroker speichern
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
      }

      log(`[SchedC] ✓ ${Math.min(storeCount, maxChargeSchedules)} Lade-Zeitplan(e) im ioBroker gespeichert`, 'info');
      if (debug >= 1) cfgSchedules.slice(0, maxChargeSchedules).forEach((s, i) =>
         log(`[SchedC]   [${i}] ${s.startTime}-${s.endTime} ${JSON.stringify(s.days)} (${s.scheduleId})`, 'info')
      );
      return cfgSchedules;
   }

   // ------------------------------------------------
   // restoreChargeSchedules: Lade-Zeitpläne aus ioBroker wiederherstellen
   // Strategie: Alle vorhandenen Cloud-Zeitpläne per Soft-Delete löschen,
   // dann alle gespeicherten ioBroker-Zeitpläne neu anlegen (POST).
   // ------------------------------------------------
   async restoreChargeSchedules() {
      log('[SchedC] ▶ Stelle Lade-Zeitpläne wieder her (delete-all → create-all)', 'info');
      await this.ensureTokens();

      const storedRaw = getState(dpSchedC + 'raw_json').val;
      let storedSchedules = [];
      try {
         storedSchedules = JSON.parse(storedRaw || '[]');
      } catch (e) { /* ignore */ }

      if (!storedSchedules || storedSchedules.length === 0) {
         log('[SchedC] ⚠ Keine gespeicherten Lade-Zeitpläne vorhanden – zuerst "read_charge_schedules" ausführen!', 'warn');
         return;
      }
      log(`[SchedC] ${storedSchedules.length} gespeicherte(r) Lade-Zeitplan(e) als Referenz`, 'info');

      const baseHeaders = {
         'Content-Type':  'application/json',
         'e-auth-token':  this.jwtToken,
         'x-xsrf-token':  this.xsrfToken,
         'username':      String(this.userId),
         'origin':        BATTERY_UI_BASE,
         'referer':       BATTERY_UI_BASE + '/',
      };
      const schedUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/battery/sites/${this.batteryId}/schedules`;

      // Schritt 1: Aktuelle Cloud-Zeitpläne ermitteln und per Soft-Delete löschen
      const currentSchedules = await this.readChargeSchedules();
      log(`[SchedC] ${currentSchedules.length} vorhandene(r) Cloud-Zeitplan(e) werden gelöscht`, 'info');
      let deleted = 0;
      for (const s of currentSchedules) {
         const delUrl = `${schedUrl}/${s.scheduleId}`;
         log(`[SchedC] Soft-Delete ${s.scheduleId} (${s.startTime}-${s.endTime})`, 'info');
         const delResp = await this._fetch(delUrl, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify({ isDeleted: true }),
         });
         const delText = await delResp.text();
         if (delResp.ok) { deleted++; }
         else { log(`[SchedC] ⚠ Soft-Delete fehlgeschlagen (HTTP ${delResp.status}): ${delText}`, 'warn'); }
      }
      log(`[SchedC] ${deleted}/${currentSchedules.length} Zeitplan(e) gelöscht`, 'info');

      // Schritt 2: Alle gespeicherten Zeitpläne neu anlegen
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

         log(`[SchedC] POST – ${payload.startTime}-${payload.endTime} limit=${payload.limit ?? '-'}% ${JSON.stringify(payload.days)}`, 'info');
         const resp = await this._fetch(schedUrl, {
            method:  'POST',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const respText = await resp.text();
         if (resp.ok) {
            log(`[SchedC] ✓ Zeitplan angelegt (HTTP ${resp.status}): ${respText.substring(0, 100)}`, 'info');
            restored++;
         } else {
            log(`[SchedC] ⚠ Fehler bei Zeitplan ${payload.startTime}-${payload.endTime}: HTTP ${resp.status} – ${respText}`, 'warn');
         }
      }

      log(`[SchedC] ✓ Wiederherstellung: ${restored}/${storedSchedules.length} Lade-Zeitplan(e) angelegt`, 'info');
      if (restored > 0) await this.readChargeSchedules();
   }

   // ------------------------------------------------
   // deleteDischargeSchedules: Alle Entlade-Zeitpläne (RBD) in der Enphase Cloud löschen
   // Soft-Delete per PUT mit isDeleted:true
   // ------------------------------------------------
   async deleteDischargeSchedules() {
      log('[SchedD] ▶ Lösche alle Entlade-Zeitpläne in der Enphase Cloud', 'info');
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
         log('[SchedD] ℹ Keine aktiven Entlade-Zeitpläne in der Cloud – leere ioBroker-States', 'info');
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
         log(`[SchedD] DELETE (soft) ${s.scheduleId} – ${s.startTime}-${s.endTime}`, 'info');
         const resp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const text = await resp.text();
         if (resp.ok) { deleted++; }
         else { log(`[SchedD] ⚠ Soft-Delete fehlgeschlagen (HTTP ${resp.status}): ${text}`, 'warn'); }
      }
      log(`[SchedD] ✓ ${deleted}/${currentSchedules.length} Entlade-Zeitplan(e) gelöscht`, 'info');

      // ioBroker-Datenpunkte neutralisieren (nur bei manueller Löschung)
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
      log('[SchedD] ✓ ioBroker-Datenpunkte für Entlade-Zeitpläne geleert', 'info');
   }

   // ------------------------------------------------
   // deleteChargeSchedules: Alle Lade-Zeitpläne (CFG) in der Enphase Cloud löschen
   // Soft-Delete per PUT mit isDeleted:true
   // ------------------------------------------------
   async deleteChargeSchedules() {
      log('[SchedC] ▶ Lösche alle Lade-Zeitpläne in der Enphase Cloud', 'info');
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
         log('[SchedC] ℹ Keine aktiven Lade-Zeitpläne in der Cloud – leere ioBroker-States', 'info');
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
         log(`[SchedC] DELETE (soft) ${s.scheduleId} – ${s.startTime}-${s.endTime}`, 'info');
         const resp = await this._fetch(`${schedUrl}/${s.scheduleId}`, {
            method:  'PUT',
            headers: baseHeaders,
            body:    JSON.stringify(payload),
         });
         const text = await resp.text();
         if (resp.ok) { deleted++; }
         else { log(`[SchedC] ⚠ Soft-Delete fehlgeschlagen (HTTP ${resp.status}): ${text}`, 'warn'); }
      }
      log(`[SchedC] ✓ ${deleted}/${currentSchedules.length} Lade-Zeitplan(e) gelöscht`, 'info');

      // ioBroker-Datenpunkte neutralisieren (nur bei manueller Löschung)
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
      log('[SchedC] ✓ ioBroker-Datenpunkte für Lade-Zeitpläne geleert', 'info');
   }

   // ------------------------------------------------
   // getMqttSignedUrl: Signierte WebSocket-URL für AWS IoT MQTT holen
   // ------------------------------------------------
   async getMqttSignedUrl() {
      log('[MQTT] Rufe MQTT Signed URL ab', 'info');
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
      log(`[MQTT] Signed URL Response (HTTP ${response.status}): ${text}`, 'info');
      if (!response.ok) throw new Error(`getMqttSignedUrl fehlgeschlagen: HTTP ${response.status} – ${text}`);
      return JSON.parse(text);
   }

   // ------------------------------------------------
   // changeBatteryViaMqtt: RBD-Einstellung für Systeme mit supportsMqtt:true
   // Analyse des Browser-Quellcodes (battery-profile-ui) ergab:
   //   1. WS-URL hat KEINE Query-Parameter – die Auth geht als MQTT-Username!
   //   2. MQTT username = "?x-amz-customauthorizer-name=...&enph_token=...&site-id=...&signature=...&env=..."
   //   3. MQTT 3.1.1 (Level 4), kein Passwort
   //   4. Origin = BATTERY_UI_BASE (nicht enlighten!)
   //   5. Browser subscribt auf Response-Topic, sendet Befehl per REST PUT
   //   6. Wir versuchen zusätzlich REST PUT auf battery-profile-ui-Endpunkt
   // @param {boolean} enable
   // @param {object}  mqttInfo  – Rückgabe von getMqttSignedUrl()
   // ------------------------------------------------
   async changeBatteryViaMqtt(enable, mqttInfo) {
      let mqtt;
      try {
         // @ts-ignore
         mqtt = require('mqtt');
      } catch (e) {
         throw new Error('mqtt-Paket nicht verfügbar – bitte installieren: npm install mqtt');
      }

      // mqttInfo-Felder:
      //   aws_iot_endpoint  → MQTT-Broker-Host
      //   aws_authorizer    → Custom-Authorizer-Name
      //   aws_token_key     → Query-Param-Name (z.B. "enph_token")
      //   aws_token_value   → Session-Token-Wert
      //   aws_digest        → Base64-Signatur (wird encodeURIComponent-kodiert)
      //   topic             → Response-Stream-Topic (v1/server/response-stream/{sessionId})
      const endpoint      = mqttInfo.aws_iot_endpoint;
      const authorizer    = mqttInfo.aws_authorizer;
      const tokenKey      = mqttInfo.aws_token_key;
      const tokenValue    = mqttInfo.aws_token_value;
      const digest        = mqttInfo.aws_digest;
      const responseTopic = mqttInfo.topic;

      if (!endpoint) throw new Error(`aws_iot_endpoint fehlt in mqttInfo: ${JSON.stringify(Object.keys(mqttInfo))}`);

      // Session-ID aus dem Response-Topic
      const sessionId = responseTopic ? responseTopic.split('/').pop() : '';
      log(`[MQTT] Session-ID: ${sessionId}`, 'info');

      // Client-ID im Paho-MQTT-Stil (Browser: bp-paho-mqtt-{4 Zufallszeichen})
      const mqttClientId = `bp-paho-mqtt-${Math.random().toString(36).substring(2, 6)}`;
      log(`[MQTT] Client-ID: ${mqttClientId}`, 'info');

      // SCHLÜSSEL-ERKENNTNIS (aus Battery-UI-JS-Analyse):
      // WS-URL hat KEINE Query-Parameter!
      // Die Auth-Daten gehen als MQTT-username (Format wie Paho es baut):
      //   "?x-amz-customauthorizer-name=AUTHORIZER&TOKEN_KEY=TOKEN_VALUE&site-id=SITE_ID&x-amz-customauthorizer-signature=ENCODED_DIGEST&env=production"
      // Digest wird encodeURIComponent-kodiert, alle anderen Werte NICHT.
      const wsUrl       = `wss://${endpoint}/mqtt`;
      const mqttUsername = `?x-amz-customauthorizer-name=${authorizer}` +
         `&${tokenKey}=${tokenValue}` +
         `&site-id=${this.batteryId}` +
         `&x-amz-customauthorizer-signature=${encodeURIComponent(digest)}` +
         `&env=production`;

      log(`[MQTT] WSS URL: ${wsUrl}  (keine Query-Params!)`, 'info');
      log(`[MQTT] MQTT username: ?x-amz-customauthorizer-name=${authorizer}&${tokenKey}=***&site-id=${this.batteryId}&...`, 'info');
      log(`[MQTT] Response-Topic (subscribe): ${responseTopic}`, 'info');

      // MQTT-Verbindung aufbauen
      return new Promise((resolve, reject) => {
         log('[MQTT] Starte MQTT-Verbindung (MQTT 3.1.1, Auth via username)...', 'info');

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
               username:        mqttUsername, // Auth als MQTT-username!
               // kein password
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
            reject(new Error(`mqtt.connect() Fehler: ${e instanceof Error ? e.message : String(e)}`));
            return;
         }
         log('[MQTT] Warte auf connect-Event...', 'info');

         const timer = setTimeout(() => {
            log('[MQTT] Timeout (20s)', 'warn');
            client.end(true);
            settle(reject, new Error('MQTT Verbindungs-Timeout (20s)'));
         }, 20000);

         client.on('connect', async () => {
            log('[MQTT] Verbunden ✓ (CONNACK 0x00)', 'info');

            // Response-Topic abonnieren (Browser macht das auch)
            client.subscribe(responseTopic, { qos: 1 }, (subErr) => {
               if (subErr) log(`[MQTT] Subscribe-Fehler: ${subErr.message}`, 'warn');
               else        log(`[MQTT] Abonniert: ${responseTopic}`, 'info');
            });

            // Batterie-Einstellung per REST PUT senden (wie Browser es macht)
            // API-Backend ist auf enlighten.enphaseenergy.com (window.build_domain_api aus battery-profile-ui HTML)
            // Browser verwendet SET_BATTERY_CONFIG = "/batterySettings/@SITE_ID?@USER_ID" (KEIN source=enho!)
            const batteryUrl = `${ENLIGHTEN_BASE}/service/batteryConfig/api/v1/batterySettings/${this.batteryId}?userId=${this.userId}`;
            const payload    = JSON.stringify({ rbdControl: { enabled: enable } });
            log(`[MQTT] REST PUT ${batteryUrl}`, 'info');
            log(`[MQTT] REST Payload: ${payload}`, 'info');

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
               log(`[MQTT] REST Antwort: HTTP ${restResp.status} – ${restBody}`, restResp.ok ? 'info' : 'warn');

               if (restResp.ok) {
                  // 10s warten für mögliche MQTT-Antwort, dann resolve
                  setTimeout(() => { client.end(); settle(resolve, true); }, 10000);
               } else if (restResp.status === 403) {
                  // Token erneuern und nochmal versuchen
                  log('[MQTT] REST 403 – erneuere Tokens und wiederhole', 'warn');
                  await this.ensureTokens(true);
                  restHeaders['e-auth-token'] = this.jwtToken;
                  restHeaders['x-xsrf-token'] = this.xsrfToken;
                  const restResp2 = await this._fetch(batteryUrl, { method: 'PUT', headers: restHeaders, body: payload });
                  const restBody2 = await restResp2.text();
                  log(`[MQTT] REST Wiederholung: HTTP ${restResp2.status} – ${restBody2}`, restResp2.ok ? 'info' : 'warn');
                  client.end();
                  if (restResp2.ok) settle(resolve, true);
                  else settle(reject, new Error(`REST PUT fehlgeschlagen: HTTP ${restResp2.status} – ${restBody2}`));
               } else {
                  client.end();
                  settle(reject, new Error(`REST PUT fehlgeschlagen: HTTP ${restResp.status} – ${restBody}`));
               }
            } catch (restErr) {
               log(`[MQTT] REST Fehler: ${restErr instanceof Error ? restErr.message : String(restErr)}`, 'warn');
               client.end();
               settle(reject, restErr instanceof Error ? restErr : new Error(String(restErr)));
            }
         });

         client.on('message', (topic, msg) => {
            log(`[MQTT] Server-Antwort auf ${topic}: ${msg.toString()}`, 'info');
            // Bei profile_change_response sofort resolve
            try {
               const parsed = JSON.parse(msg.toString());
               if (parsed.messageType === 'profile_change_response' ||
                   parsed.messageType === 'storm_change_response') {
                  log('[MQTT] ✓ Änderung bestätigt per MQTT', 'info');
                  client.end();
                  settle(resolve, true);
               }
            } catch (e) { /* kein JSON – ignorieren */ }
         });

         client.on('error', (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            log(`[MQTT] Fehler: ${msg}`, 'warn');
            settle(reject, new Error(`MQTT Verbindungsfehler: ${msg}`));
         });

         client.on('close', () => {
            log('[MQTT] Verbindung geschlossen', 'info');
            settle(reject, new Error('MQTT Verbindung geschlossen (vor connect)'));
         });

         client.on('offline', () => {
            log('[MQTT] Client offline', 'warn');
         });
      });
   }

   // ------------------------------------------------
   // Cache laden / speichern
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
            if (debug >= 1) log('[Cache] Tokens aus Datei-Cache geladen', 'info');
         }
      } catch (e) {
         if (debug >= 1) log(`[Cache] Fehler beim Laden: ${e instanceof Error ? e.message : String(e)}`, 'warn');
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
         if (debug >= 2) log('[Cache] Tokens gespeichert', 'info');
      } catch (e) {
         if (debug >= 1) log(`[Cache] Fehler beim Speichern: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }

   // ------------------------------------------------
   // States lesen / schreiben
   // ------------------------------------------------
   async _saveToStates() {
      try {
         if (this.jwtToken)   setState(dpStatus + 'jwt_token',   this.jwtToken,  true);
         if (this.jwtExp)     setState(dpStatus + 'jwt_expires', new Date(this.jwtExp * 1000).toISOString(), true);
         if (this.xsrfToken)  setState(dpStatus + 'xsrf_token', this.xsrfToken, true);
         if (this.userId)     setState(dpStatus + 'user_id',     this.userId,    true);
         if (this.batteryId)  setState(dpStatus + 'battery_id',  this.batteryId, true);
         setState(dpStatus + 'last_login', new Date().toISOString(), true);
      } catch (e) {
         if (debug >= 1) log(`[States] Fehler: ${e instanceof Error ? e.message : String(e)}`, 'warn');
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
         if (debug >= 1) log('[States] Tokens aus ioBroker States geladen', 'info');
      } catch (e) {
         if (debug >= 1) log(`[States] Fehler beim Lesen: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
   }
}

// -------------------------------------------------------------------------------------------------------------------
// Hauptprogramm
// -------------------------------------------------------------------------------------------------------------------

// Credentials aus ioBroker States lesen
const email    = getState(dpConfig + 'email').val    || '';
const password = getState(dpConfig + 'password').val || '';

if (!email || !password) {
   log('Enphase Email und/oder Passwort nicht konfiguriert!', 'warn');
   log(`  Bitte eintragen in: ${dpConfig}email  und  ${dpConfig}password`, 'warn');
}

// Client instanziieren
const enphaseClient = new EnphaseCloudClient(email, password);

// Tokens aus dem letzten Run laden (Datei-Cache hat Vorrang vor States)
enphaseClient.loadFromStates();
enphaseClient.loadCache();

// FIX: login() ist async – muss in einer async-IIFE aufgerufen werden.
// Vorher: enphaseClient.login() ohne await → Promise ignoriert, Fehler verschluckt.
// Jetzt:  Fehler werden korrekt geloggt, Script läuft danach weiter.
(async () => {
   if (email && password) {
      try {
         if (!enphaseClient.checkToken()) {
            await enphaseClient.login();
         } else {
            if (debug >= 1) log('[Init] Gültiger Token aus Cache – kein Neulogin nötig', 'info');
         }
         // Nach Login: aktuellen Cloud-Status lesen und States synchronisieren
         await enphaseClient.readBatteryDischargeStatus();
         await enphaseClient.readChargeFromGrid();
         await enphaseClient.readDischargeSchedules();
         await enphaseClient.readChargeSchedules();
      } catch (err) {
         log(`[Init] Startup fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
   }
})();

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Reaktion auf Schalterwechsel
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'battery_discharge_restrict', change: 'ne', ack: false }, async (obj) => {
   const enable = !!obj.state.val;
   if (debug >= 1) log(`[Trigger] Batterieentladung einschränken -> ${enable}`, 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert – Aktion abgebrochen', 'error');
      return;
   }

   try {
      await enphaseClient.changeBatteryDischargeSwitch(enable);
   } catch (err) {
      log(`[Fehler] changeBatteryDischargeSwitch: ${err instanceof Error ? err.message : String(err)}`, 'error');
      // State zurücksetzen auf den alten Wert (Fehlerfall)
      setState(dpControl + 'battery_discharge_restrict', !enable, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Manueller Status-Abruf über read_battery_status Datenpunkt
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_battery_status', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return; // nur bei true auslösen
   if (debug >= 1) log('[Trigger] Manueller Status-Abruf ausgelöst', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert – Aktion abgebrochen', 'error');
      return;
   }

   try {
      await enphaseClient.readBatteryDischargeStatus();
   } catch (err) {
      log(`[Fehler] readBatteryDischargeStatus: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_battery_status', false, true); // Button zurücksetzen
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Netzlade-Status manuell abrufen
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_charge_from_grid_status', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Manueller Netzlade-Status-Abruf ausgelöst', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert – Aktion abgebrochen', 'error');
      setState(dpControl + 'read_charge_from_grid_status', false, true);
      return;
   }

   try {
      await enphaseClient.readChargeFromGrid();
   } catch (err) {
      log(`[Fehler] readChargeFromGrid: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_charge_from_grid_status', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: "Laden über Stromnetz" Schalter
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'battery_charge_from_grid_enable', change: 'ne', ack: false }, async (obj) => {
   const enable = !!obj.state.val;
   if (debug >= 1) log(`[Trigger] Netzladen -> ${enable}`, 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert – Aktion abgebrochen', 'error');
      return;
   }

   try {
      await enphaseClient.changeChargeFromGrid(enable);
   } catch (err) {
      log(`[Fehler] changeChargeFromGrid: ${err instanceof Error ? err.message : String(err)}`, 'error');
      // State zurücksetzen auf den alten Wert (Fehlerfall)
      setState(dpControl + 'battery_charge_from_grid_enable', !enable, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Zeitpläne manuell auslesen
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Lese Entlade-Zeitpläne aus Cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'read_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.readDischargeSchedules();
   } catch (err) {
      log(`[Fehler] readDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_discharge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Zeitpläne manuell wiederherstellen
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'restore_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Stelle Entlade-Zeitpläne wieder her', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'restore_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.restoreDischargeSchedules();
   } catch (err) {
      log(`[Fehler] restoreDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'restore_discharge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Lade-Zeitpläne manuell auslesen
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'read_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Lese Lade-Zeitpläne aus Cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'read_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.readChargeSchedules();
   } catch (err) {
      log(`[Fehler] readChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'read_charge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// State-Subscription: Lade-Zeitpläne manuell wiederherstellen
// -------------------------------------------------------------------------------------------------------------------
on({ id: dpControl + 'restore_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Stelle Lade-Zeitpläne wieder her', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'restore_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.restoreChargeSchedules();
   } catch (err) {
      log(`[Fehler] restoreChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'restore_charge_schedules', false, true);
   }
});

on({ id: dpControl + 'delete_discharge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Lösche alle Entlade-Zeitpläne in der Cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'delete_discharge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.deleteDischargeSchedules();
   } catch (err) {
      log(`[Fehler] deleteDischargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'delete_discharge_schedules', false, true);
   }
});

on({ id: dpControl + 'delete_charge_schedules', change: 'any', ack: false }, async (obj) => {
   if (!obj.state.val) return;
   if (debug >= 1) log('[Trigger] Lösche alle Lade-Zeitpläne in der Cloud', 'info');

   if (!enphaseClient.email || !enphaseClient.password) {
      log('[Fehler] Keine Credentials konfiguriert', 'error');
      setState(dpControl + 'delete_charge_schedules', false, true);
      return;
   }
   try {
      await enphaseClient.deleteChargeSchedules();
   } catch (err) {
      log(`[Fehler] deleteChargeSchedules: ${err instanceof Error ? err.message : String(err)}`, 'error');
   } finally {
      setState(dpControl + 'delete_charge_schedules', false, true);
   }
});

// -------------------------------------------------------------------------------------------------------------------
// Auto-Acknowledge für Schedule-Datenpunkte
// Wenn Benutzer einen Schedule-Wert manuell im ioBroker bearbeitet, wird der neue Wert
// sofort mit ack=true bestätigt. Ohne diese Subscription zeigt das ioBroker-Admin-Frontend
// weiterhin den letzten bestätigten Wert (ack=true) und ignoriert die unbestätigte Änderung.
// Prefix: dpBase + 'schedules.' erfasst sowohl schedules.discharge.* als auch schedules.charge.*
// -------------------------------------------------------------------------------------------------------------------
on({ id: new RegExp('^' + dpBase.replace(/\./g, '\\.') + 'schedules\\.'), change: 'any', ack: false }, (obj) => {
   if (obj.id && obj.state) setState(obj.id, obj.state.val, true);
});

// -------------------------------------------------------------------------------------------------------------------
// Tägliche Token-Erneuerung
// -------------------------------------------------------------------------------------------------------------------
schedule('0 3 * * *', async () => {
   if (debug >= 1) log('[Schedule] Tägliche Token-Überprüfung', 'info');
   if (!enphaseClient.checkToken()) {
      try {
         await enphaseClient.login();
      } catch (err) {
         log(`[Schedule] Token-Erneuerung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
   }
});

if (debug >= 0) log('[Init] Enphase Battery Control Script gestartet ✓', 'info');
if (debug >= 0) log(`[Init] Schalter-Datenpunkt: ${dpControl}battery_discharge_restrict`, 'info');
