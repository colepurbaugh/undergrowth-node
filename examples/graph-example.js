/***************************************************************************
 * index.js - Combined Express + MQTT broker server
 * 
 * This file hosts:
 *  1) An Express webserver on port 3000
 *  2) An Aedes MQTT broker on port 1883
 *  3) Logic to insert sensor data (temp/humidity) into SQLite when 
 *     received via MQTT on topic "growop/sensor/<DEVICE_ID>"
 *  4) The same routes and DB code from your old index.js, minus /api/esp-data
 ***************************************************************************/

// -------------------- Dependencies --------------------
const express = require('express');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { setupRelay } = require('./USBRELAY');  // your custom relay file
const { exec } = require('child_process');
const schedule = require('node-schedule');
const nodemailer = require('nodemailer');

// For the MQTT broker:
const aedes = require('aedes')();
const net = require('net');

// -------------------- Configuration --------------------
const HTTP_PORT  = 3000;   // Express server
const MQTT_PORT  = 1883;   // MQTT broker port

// Example global min/max for temperature alerts
const MIN_TEMP = 40;
const MAX_TEMP = 95;

// A simple global boolean to track if we’re currently in an alert
let alertActive = false;

// -----------------------------------------------------------------------------
// Create Express App
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/data', express.static(path.join(__dirname, 'data')));

// Start Express
app.listen(HTTP_PORT, () => {
  console.log(`Express HTTP server running at http://localhost:${HTTP_PORT}`);
});

// -----------------------------------------------------------------------------
// Create Aedes MQTT Broker
// -----------------------------------------------------------------------------
const tcpServer = net.createServer(aedes.handle);
tcpServer.listen(MQTT_PORT, () => {
  console.log(`Aedes MQTT broker running on port ${MQTT_PORT}`);
});

// If you want MQTT over WebSocket on port 9001, you'd do something like:
/*
const http = require('http');
const ws = require('websocket-stream');
const httpServer = http.createServer();
ws.createServer({ server: httpServer }, aedes.handle);
httpServer.listen(9001, () => {
  console.log('MQTT over WebSocket running on port 9001');
});
*/

// Aedes MQTT Event Listeners
aedes.on('client', (client) => {
  console.log(`Client Connected: ${client ? client.id : client} to MQTT broker`);
});

aedes.on('clientDisconnect', (client) => {
  console.log(`Client Disconnected: ${client ? client.id : client} from MQTT broker`);
});

aedes.on('publish', (packet, client) => {
  const sender = client ? client.id : 'BROKER';
  const msgStr = packet.payload.toString();

  console.log(`[MQTT] ${sender} published topic: ${packet.topic}, message: ${msgStr}`);

  // We only process sensor data if topic starts with "growop/sensor/"
  if (packet.topic.startsWith('growop/sensor/')) {
    try {
      const data = JSON.parse(msgStr);
      const {
        device = 'ESP-UNKNOWN',
        tempF,
        humidity
      } = data;

      // Insert into DB
      const timestamp = new Date().toISOString();

      // 1) Temperature
      if (!isNaN(tempF)) {
        db.run(
          `INSERT INTO sensor_data (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)`,
          [timestamp, device, 'temperature', tempF],
          (err) => {
            if (err) console.error('Error logging temperature:', err);
          }
        );

        // Check threshold for alert
        if (!alertActive && (tempF < MIN_TEMP || tempF > MAX_TEMP)) {
          alertActive = true;
          fs.appendFileSync('alerts.log', `[${timestamp}] ALERT TRIGGERED - temp=${tempF}\n`);
          // Notify priority=0 contacts
          for (const cKey of Object.keys(contacts)) {
            const contact = contacts[cKey];
            if (contact.PRIORITY === '0') {
              sendTextAlert(contact, tempF);
            }
          }
        }
      }

      // 2) Humidity
      if (!isNaN(humidity)) {
        db.run(
          `INSERT INTO sensor_data (timestamp, device_id, type, value) VALUES (?, ?, ?, ?)`,
          [timestamp, device, 'humidity', humidity],
          (err) => {
            if (err) console.error('Error logging humidity:', err);
          }
        );
      }

    } catch (err) {
      console.error('[MQTT] JSON parse error:', err);
    }
  }
});

aedes.on('subscribe', (subscriptions, client) => {
  console.log(`[MQTT] ${client ? client.id : client} subscribed to:`,
    subscriptions.map(s => s.topic).join(', '));
});

// -----------------------------------------------------------------------------
// Remove the old /api/esp-data route since we now use MQTT for sensor data
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// The rest of your existing Express routes remain unchanged
// -----------------------------------------------------------------------------

app.post('/api/plants/add', (req, res) => {
  try {
    let plants = JSON.parse(fs.readFileSync('data/plant_list.json', 'utf8'));
    const { newPlants } = req.body;

    newPlants.forEach(obj => {
      const newID = Object.keys(obj)[0];
      plants[newID] = obj[newID];
    });

    fs.writeFileSync('data/plant_list.json', JSON.stringify(plants, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to add plants:', error);
    res.status(500).json({ error: 'Failed to add plants' });
  }
});

app.post('/api/plants/edit', (req, res) => {
  try {
    let plants = JSON.parse(fs.readFileSync('data/plant_list.json', 'utf8'));
    const { plantID, data } = req.body;

    if (!plants[plantID]) {
      return res.status(404).json({ error: 'Plant not found' });
    }
    plants[plantID] = { ...plants[plantID], ...data };
    fs.writeFileSync('data/plant_list.json', JSON.stringify(plants, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update plant' });
  }
});

app.delete('/api/plants/delete/:id', (req, res) => {
  try {
    let plants = JSON.parse(fs.readFileSync('data/plant_list.json', 'utf8'));
    const plantID = req.params.id;
    if (!plants[plantID]) {
      return res.status(404).json({ error: 'Plant not found' });
    }
    delete plants[plantID];
    fs.writeFileSync('data/plant_list.json', JSON.stringify(plants, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete plant' });
  }
});

app.post('/api/devices/add', (req, res) => {
  try {
    let devices = JSON.parse(fs.readFileSync('data/device_list.json', 'utf8'));
    const { newDevices } = req.body;
    newDevices.forEach(obj => {
      const theID = Object.keys(obj)[0];
      devices[theID] = obj[theID];
    });
    fs.writeFileSync('data/device_list.json', JSON.stringify(devices, null, 2));
    return res.json({ success: true });
  } catch (error) {
    console.error('Failed to add devices:', error);
    res.status(500).json({ error: 'Failed to add devices' });
  }
});

app.post('/api/devices/edit', (req, res) => {
  try {
    let devices = JSON.parse(fs.readFileSync('data/device_list.json', 'utf8'));
    const { deviceID, data } = req.body;

    if (!devices[deviceID]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    devices[deviceID] = { ...devices[deviceID], ...data };
    fs.writeFileSync('data/device_list.json', JSON.stringify(devices, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

app.delete('/api/devices/delete/:id', (req, res) => {
  try {
    let devices = JSON.parse(fs.readFileSync('data/device_list.json', 'utf8'));
    const deviceID = req.params.id;
    if (!devices[deviceID]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    delete devices[deviceID];
    fs.writeFileSync('data/device_list.json', JSON.stringify(devices, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

//--------------------------------------------------------------------------------------------------------------
// Alerts
//--------------------------------------------------------------------------------------------------------------
app.post('/api/clear-alert', (req, res) => {
  alertActive = false;
  const now = new Date().toISOString();
  fs.appendFileSync('alerts.log', `[${now}] ALERT CLEARED by user\n`);
  res.json({ success: true, message: 'Alert has been cleared' });
});

app.post('/api/test-alert', (req, res) => {
  if (!alertActive) {
    alertActive = true;
    const now = new Date().toISOString();
    fs.appendFileSync('alerts.log', `[${now}] TEST ALERT TRIGGERED\n`);
    for (const cKey of Object.keys(contacts)) {
      const c = contacts[cKey];
      if (c.PRIORITY === '0') {
        sendTextAlert(c, 'TEST ALERT: This is only a test');
      }
    }
  }
  return res.json({ success: true, message: 'Test alert triggered.' });
});

//--------------------------------------------------------------------------------------------------------------
// Backup & Relay
//--------------------------------------------------------------------------------------------------------------
app.post('/api/backup', (req, res) => {
  console.log('Manual backup requested...');
  backupDatabase();
  res.json({ success: true, message: 'Backup started' });
});

app.post('/relay/on', (req, res) => {
  if (relay) {
    const result = relay.toggleRelay();
    res.json({ success: true, message: `Relay turned ON: ${result.state}` });
  } else {
    res.status(500).json({ error: 'Relay not connected' });
  }
});

app.post('/relay/off', (req, res) => {
  if (relay) {
    const result = relay.toggleRelay();
    res.json({ success: true, message: `Relay turned OFF: ${result.state}` });
  } else {
    res.status(500).json({ error: 'Relay not connected' });
  }
});

//--------------------------------------------------------------------------------------------------------------
// READINGS Endpoints
//--------------------------------------------------------------------------------------------------------------
// (unchanged from your existing code) ...
// READINGS endpoint with partial-day logic
app.get('/api/readings', (req, res) => {
  console.log('Incoming /api/readings =>', req.query);

  let { range, device, start, end, points, metric } = req.query;
  let sql;
  let params = [];
  const limit = parseInt(points) || 200; // max # of rows

  if (!device || !metric) {
    return res.status(400).json({ error: 'Missing device or metric' });
  }

  // If "start" includes a 'T', assume it's a full ISO date/time (partial day)
  if (start && start.includes('T')) {
    // e.g. "2025-02-08T03:00:00.000Z" or local offset
    // parse as Date, then convert to ISO again
    const parsed = new Date(start);
    if (isNaN(parsed)) {
      return res.status(400).json({ error: 'Invalid start param' });
    }
    const startIso = parsed.toISOString();
    // range => e.g. "28800" => 8 hours
    if (!range) {
      return res.status(400).json({ error: 'Missing range param for partial-day usage' });
    }
    const rangeSeconds = parseInt(range, 10);
    const endDate = new Date(parsed.getTime() + (rangeSeconds * 1000));
    const endIso = endDate.toISOString();

    sql = `
      SELECT * FROM sensor_data
      WHERE timestamp BETWEEN ? AND ?
        AND device_id = ?
        AND type = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;
    params.push(startIso, endIso, device, metric, limit);

    return db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Error fetching partial-day data:', err);
        return res.status(500).json({ error: 'Failed to fetch partial-day data' });
      }
      return res.json(rows);
    });
  }

  // Otherwise do old logic
  // 1) If user gave start but not end => interpret as "YYYY-MM-DD" to now
  if (start && !end) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      // parse as midnight local
      const [yyyy, mm, dd] = start.split('-').map(Number);
      const localMidnight = new Date(yyyy, mm - 1, dd);
      const startIso = localMidnight.toISOString();
      const nowIso = new Date().toISOString();

      sql = `
        SELECT * FROM sensor_data
        WHERE timestamp BETWEEN ? AND ?
          AND device_id = ?
          AND type = ?
        ORDER BY timestamp ASC
        LIMIT ?
      `;
      params.push(startIso, nowIso, device, metric, limit);

    } else {
      return res.status(400).json({ error: 'Invalid start parameter format' });
    }
  } else if (start && end) {
    // Original scenario: start/end represent "days ago"
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(start));
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date();
    endDate.setDate(endDate.getDate() - parseInt(end));
    endDate.setHours(23, 59, 59, 999);

    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid date range' });
    }
    sql = `
      SELECT * FROM sensor_data
      WHERE timestamp BETWEEN ? AND ?
        AND device_id = ?
        AND type = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;
    params.push(startDate.toISOString(), endDate.toISOString(), device, metric, limit);

  } else if (range) {
    // e.g. range=3600 => last hour
    const rangeSeconds = parseInt(range);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - rangeSeconds * 1000);

    sql = `
      SELECT * FROM sensor_data
      WHERE timestamp BETWEEN ? AND ?
        AND device_id = ?
        AND type = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;
    params.push(startDate.toISOString(), endDate.toISOString(), device, metric, limit);

  } else {
    return res.status(400).json({ error: 'Invalid query parameters (no range or start)' });
  }

  // Execute the query
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Error fetching data from SQLite:', err);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    res.json(rows);
  });
});

// Binned Readings Endpoint
app.get('/api/readings/binned', async (req, res) => {
  try {
    const device = req.query.device;       // e.g. "7E58"
    const metric = req.query.metric;       // e.g. "temperature"
    const startDateParam = req.query.startDate; // e.g. "2025-02-07T02:00:00.000Z"
    const hours = parseInt(req.query.hours, 10);  // e.g. 8
    const binCount = parseInt(req.query.points, 10); // e.g. 500

    // Validate
    if (!device || !metric || !startDateParam || !hours || !binCount) {
      return res.status(400).json({
        error: 'Missing device, metric, startDate, hours, or points'
      });
    }

    // Convert startDate to numeric epoch
    const startMs = Date.parse(startDateParam);
    if (isNaN(startMs)) {
      return res.status(400).json({ error: 'Invalid startDate format' });
    }
    const endMs = startMs + (hours * 3600 * 1000); // add X hours in ms

    // Convert to ISO for DB query
    const startIso = new Date(startMs).toISOString();
    const endIso   = new Date(endMs).toISOString();

    // 1) Fetch raw rows from DB
    const rawRows = await new Promise((resolve, reject) => {
      const sql = `
        SELECT timestamp, value
        FROM sensor_data
        WHERE device_id = ?
          AND type = ?
          AND timestamp >= ?
          AND timestamp < ?
        ORDER BY timestamp ASC
      `;
      db.all(sql, [device, metric, startIso, endIso], (err, rows) => {
        if (err) return reject(err);
        resolve(rows);
      });
    });

    if (!rawRows || rawRows.length === 0) {
      return res.json([]); // no data in that range => return empty
    }

    // 2) Create bins
    const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
    const totalMs   = endMs - startMs;
    const binSizeMs = totalMs / binCount; // ms per bin

    // 3) Distribute each raw row into the correct bin
    for (const row of rawRows) {
      const tMs = Date.parse(row.timestamp);
      const offset = tMs - startMs; // ms since start
      const index = Math.floor(offset / binSizeMs);
      if (index >= 0 && index < binCount) {
        bins[index].sum   += row.value;
        bins[index].count += 1;
      }
    }

    // 4) Build final output array
    const result = bins.map((b, i) => {
      const binStartMs = startMs + (i * binSizeMs);
      return {
        timestamp: new Date(binStartMs).toISOString(),
        value: (b.count === 0) ? null : (b.sum / b.count)
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Error in /api/readings/binned:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
// etc.

//--------------------------------------------------------------------------------------------------------------
// Additional Endpoints
//--------------------------------------------------------------------------------------------------------------
app.get('/api/plants', (req, res) => {
  try {
    const plants = JSON.parse(fs.readFileSync('data/plant_list.json', 'utf8'));
    res.json(plants);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read plant list' });
  }
});

app.get('/edit', (req, res) => {
  res.sendFile(path.join(__dirname, 'edit_json.html'));
});

app.get('/api/alert-state', (req, res) => {
  res.json({ alertActive });
});

app.get('/api/sensor-info/:deviceId', (req, res) => {
  const deviceId = req.params.deviceId;
  let sensorInfo = {};

  db.get(
    `SELECT * FROM sensor_data WHERE device_id = ? ORDER BY timestamp ASC LIMIT 1`,
    [deviceId],
    (err, earliest) => {
      if (err) {
        console.error("Error fetching earliest sensor data:", err);
        return res.status(500).json({ error: 'Failed to fetch sensor data' });
      }
      sensorInfo.earliest = earliest;

      db.get(
        `SELECT * FROM sensor_data WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1`,
        [deviceId],
        (err, latest) => {
          if (err) {
            console.error("Error fetching latest sensor data:", err);
            return res.status(500).json({ error: 'Failed to fetch sensor data' });
          }
          sensorInfo.latest = latest;

          db.get(
            `SELECT MIN(value) as minTemp, MAX(value) as maxTemp, AVG(value) as avgTemp, COUNT(*) as countTemp
             FROM sensor_data WHERE device_id = ? AND type = 'temperature'`,
            [deviceId],
            (err, tempSummary) => {
              if (err) {
                console.error("Error fetching temperature summary:", err);
                return res.status(500).json({ error: 'Failed to fetch sensor data' });
              }
              sensorInfo.temperatureSummary = tempSummary;

              db.get(
                `SELECT MIN(value) as minHum, MAX(value) as maxHum, AVG(value) as avgHum, COUNT(*) as countHum
                 FROM sensor_data WHERE device_id = ? AND type = 'humidity'`,
                [deviceId],
                (err, humSummary) => {
                  if (err) {
                    console.error("Error fetching humidity summary:", err);
                    return res.status(500).json({ error: 'Failed to fetch sensor data' });
                  }
                  sensorInfo.humiditySummary = humSummary;
                  res.json(sensorInfo);
                }
              );
            }
          );
        }
      );
    }
  );
});

app.get('/api/runtime', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  res.json({ runtime: `${hours}h ${minutes}m ${seconds}s` });
});

//--------------------------------------------------------------------------------------------------------------
// Helper code (contacts, email-to-SMS, DB setup, backups, etc.)
//--------------------------------------------------------------------------------------------------------------
let contacts = {};
try {
  const contactsData = fs.readFileSync(path.join(__dirname, 'contacts.json'), 'utf8');
  contacts = JSON.parse(contactsData);
} catch (err) {
  console.error('Failed to load contacts.json:', err);
}

function getSmsDomain(provider) {
  switch ((provider || '').toUpperCase()) {
    case 'VERIZON': return 'vtext.com';
    case 'ATT':     return 'txt.att.net'; 
    case 'TMOBILE': return 'tmomail.net';
    default:        return null;
  }
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'hemphortalert@gmail.com',
    pass: 'qjjw rohi wlpy dnkm'
  }
});

function sendTextAlert(contact, sensorValue) {
  const domain = getSmsDomain(contact.PROVIDER);
  if (!domain || !contact.NUMBER) {
    console.warn(`Cannot send SMS: provider/domain or number not set for ${contact.FIRST}.`);
    return;
  }
  const smsAddress = `${contact.NUMBER}@${domain}`;
  const message = `ALERT! Sensor reading is out of range: ${sensorValue}`;

  transporter.sendMail({
    from: 'Grow Alert <hemphortalert@gmail.com>',
    to: smsAddress,
    subject: '',
    text: message
  }, (err, info) => {
    if (err) {
      console.error('Failed to send alert to', smsAddress, err);
    } else {
      console.log('Alert sent to', smsAddress, info.response);
    }
  });
}

// SQLite DB
const db = new sqlite3.Database('./growdata.db', err => {
  if (err) console.error('Error connecting to SQLite:', err);
  else {
    console.log('Connected to SQLite database');
    db.run(`
      CREATE TABLE IF NOT EXISTS sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        device_id TEXT NOT NULL,
        type TEXT NOT NULL,
        value REAL NOT NULL
      )
    `, err2 => {
      if (err2) console.error('Error creating table:', err2);
      else console.log('Table initialized');
    });
  }
});

// Try to set up the USB relay
let relay = null;
try {
  relay = setupRelay('/dev/ttyUSB0', 0);
  console.log('USB relay initialized');
} catch (err) {
  console.error('USB relay not connected or failed to initialize:', err.message);
}

// Backup function
function backupDatabase() {
  const now = new Date();
  const dateTimeString = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

  const DB_PATH = path.join(__dirname, 'growdata.db');
  const BACKUP_DIR = path.join(__dirname, 'backups');
  const BACKUP_FILE = path.join(BACKUP_DIR, `growdata_${dateTimeString}_last24h.sql`);
  const ZIP_FILE = `${BACKUP_FILE}.zip`;

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const dumpCommand = `
    sqlite3 "${DB_PATH}" "SELECT * FROM sensor_data WHERE timestamp >= '${twentyFourHoursAgo}';" > "${BACKUP_FILE}"
  `;
  exec(dumpCommand, err => {
    if (err) {
      console.error('Database export failed:', err.message);
      return;
    }
    exec(`zip -j "${ZIP_FILE}" "${BACKUP_FILE}"`, zipErr => {
      if (zipErr) {
        console.error('Failed to zip the backup:', zipErr.message);
      } else {
        console.log(`[${dateTimeString}] Backup completed: ${ZIP_FILE}`);
      }
      fs.unlink(BACKUP_FILE, unlinkErr => {
        if (unlinkErr) {
          console.error('Failed to delete raw backup file:', unlinkErr.message);
        }
      });
    });
  });
}

// Daily backup @ 6 AM
schedule.scheduleJob('0 6 * * *', () => {
  console.log(`[${new Date().toISOString()}] Starting daily database backup...`);
  backupDatabase();
});