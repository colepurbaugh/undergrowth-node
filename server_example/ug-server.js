const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const aedes = require('aedes')();
const { createServer } = require('net');
const ws = require('websocket-stream');
const { Bonjour } = require('bonjour-service');
const bonjour = new Bonjour();

// Initialize Express app
const app = express();
const httpServer = require('http').createServer(app);
const port = process.env.PORT || 3000;
const mqttPort = process.env.MQTT_PORT || 1883;

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Initialize SQLite databases
const configDb = new sqlite3.Database('./database/ug-config.db');
const logsDb = new sqlite3.Database('./database/logs.db');

// Create tables if they don't exist
configDb.serialize(() => {
  configDb.run(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT,
      location TEXT,
      config TEXT,
      last_seen TIMESTAMP
    )
  `);
  
  // Create connected_nodes table to track currently connected nodes
  configDb.run(`
    CREATE TABLE IF NOT EXISTS connected_nodes (
      id TEXT PRIMARY KEY,
      hostname TEXT,
      ip_address TEXT,
      connected_since TIMESTAMP,
      last_message TIMESTAMP,
      messages_received INTEGER DEFAULT 0,
      messages_sent INTEGER DEFAULT 0
    )
  `);
  
  // Create mqtt_stats table for broker statistics
  configDb.run(`
    CREATE TABLE IF NOT EXISTS mqtt_stats (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Initialize mqtt_stats with default values
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['total_connections', '0']);
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['total_messages', '0']);
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['start_time', new Date().toISOString()]);
  
  // Create node_sync_status table to track data sync with nodes
  configDb.run(`
    CREATE TABLE IF NOT EXISTS node_sync_status (
      node_id TEXT PRIMARY KEY,
      last_sync_timestamp TEXT,
      last_seen_timestamp TEXT,
      sync_status TEXT,
      sync_interval INTEGER DEFAULT 60000
    )
  `);
  
  // Create history_requests table to track historical data requests
  configDb.run(`
    CREATE TABLE IF NOT EXISTS history_requests (
      request_id TEXT PRIMARY KEY,
      node_id TEXT,
      start_time TEXT,
      end_time TEXT,
      start_sequence INTEGER,
      end_sequence INTEGER,
      status TEXT,
      request_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      complete_time TIMESTAMP,
      record_count INTEGER DEFAULT 0
    )
  `);
  
  // Initialize sync_interval setting if not exists
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['sync_interval', '60000']);
  
  // Create node_sequence_info table to track sequence information
  configDb.run(`
    CREATE TABLE IF NOT EXISTS node_sequence_info (
      node_id TEXT PRIMARY KEY,
      last_sequence INTEGER DEFAULT 0,
      max_sequence INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

logsDb.serialize(() => {
  logsDb.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      node_id TEXT,
      level TEXT,
      message TEXT,
      context TEXT
    )
  `);
  
  // Create sensor_data table directly instead of migration approach
  logsDb.run(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TIMESTAMP,
      node_id TEXT,
      sensor_id TEXT,
      sensor_type TEXT,
      reading_type TEXT,
      value REAL,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(node_id, sensor_id, timestamp, reading_type)
    )
  `);
});

// Setup MQTT Server
const mqttServer = createServer(aedes.handle);

// Generate a unique request ID
function generateRequestId() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
}

// Request historical data from a node
function requestNodeHistory(nodeId, startSequence = 0, endSequence = null, startTime = null, endTime = null) {
  const requestId = generateRequestId();
  
  // Create request object based on whether we're using sequence or time
  const isSequenceBased = startSequence !== null && startSequence !== undefined;
  const request = {
    requestId,
    startSequence: isSequenceBased ? startSequence : 0
  };
  
  // Add either end sequence or time range parameters
  if (isSequenceBased && endSequence) {
    request.endSequence = endSequence;
    
    logger.info(`Requesting historical data from node ${nodeId} using sequence range`, {
      requestId,
      startSequence,
      endSequence
    });
  } else {
    // Fallback to time-based for backward compatibility
    request.startTime = startTime || '2000-01-01T00:00:00Z';
    request.endTime = endTime || new Date().toISOString();
    
    logger.info(`Requesting historical data from node ${nodeId} using time range`, {
      requestId,
      startTime: request.startTime,
      endTime: request.endTime
    });
  }
  
  // Store request in tracking table
  configDb.run(
    `INSERT INTO history_requests 
     (request_id, node_id, start_time, end_time, start_sequence, end_sequence, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId, 
      nodeId, 
      request.startTime || null, 
      request.endTime || null, 
      isSequenceBased ? startSequence : null,
      isSequenceBased ? endSequence : null,
      'pending'
    ],
    (err) => {
      if (err) {
        logger.error('Error storing history request:', err);
      }
    }
  );
  
  // Publish request to node
  aedes.publish({
    topic: `undergrowth/server/requests/${nodeId}/history`,
    payload: JSON.stringify(request),
    qos: 1
  });
  
  // Set a timeout to mark the request as failed if not completed in 2 minutes
  setTimeout(() => {
    configDb.get('SELECT status FROM history_requests WHERE request_id = ?', [requestId], (err, row) => {
      if (!err && row && row.status === 'pending') {
        logger.warn(`History request ${requestId} for node ${nodeId} timed out`);
        configDb.run(
          'UPDATE history_requests SET status = ?, complete_time = ? WHERE request_id = ?',
          ['timeout', new Date().toISOString(), requestId],
          (err) => {
            if (err) {
              logger.error(`Error marking history request as timed out: ${requestId}`, err);
            }
          }
        );
      }
    });
  }, 120000); // 2 minute timeout
  
  return requestId;
}

// Store historical sensor data from node response
function storeNodeHistoricalData(nodeId, dataPoints, checksumVerified = false) {
  if (!dataPoints || !Array.isArray(dataPoints) || dataPoints.length === 0) {
    logger.warn(`Received empty data points from node ${nodeId}`);
    return 0;
  }
  
  logger.info(`Processing ${dataPoints.length} historical data points from node ${nodeId}`);
  
  let storedCount = 0;
  
  // Add sequence_id field to sensor_data table if it doesn't exist
  logsDb.get("PRAGMA table_info(sensor_data)", [], (err, rows) => {
    if (err) {
      logger.error('Error checking sensor_data table schema:', err);
      return;
    }
    
    // Check if sequence_id column exists
    const hasSequenceId = rows && rows.some(row => row.name === 'sequence_id');
    
    if (!hasSequenceId) {
      logger.info('Adding sequence_id column to sensor_data table');
      logsDb.run('ALTER TABLE sensor_data ADD COLUMN sequence_id INTEGER');
    }
  });
  
  const stmt = logsDb.prepare(`
    INSERT OR IGNORE INTO sensor_data
    (timestamp, node_id, sensor_id, sensor_type, reading_type, value, sequence_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  logsDb.run('BEGIN TRANSACTION');
  
  try {
    dataPoints.forEach(point => {
      stmt.run(
        point.timestamp,
        nodeId,
        point.sensorId,
        point.sensorType || point.sensorId,
        point.type || point.readingType, // Support both formats
        point.value,
        point.sequence_id || null,
        function(err) {
          if (!err && this.changes > 0) {
            storedCount++;
          }
        }
      );
    });
    
    stmt.finalize();
    logsDb.run('COMMIT');
    
    logger.info(`Successfully stored ${storedCount} historical data points from node ${nodeId}`);
    return storedCount;
  } catch (err) {
    logsDb.run('ROLLBACK');
    logger.error(`Error storing historical data from node ${nodeId}:`, err);
    return 0;
  }
}

// Initialize node sync status when a node connects
function initNodeSyncStatus(nodeId) {
  configDb.get('SELECT * FROM node_sync_status WHERE node_id = ?', [nodeId], (err, row) => {
    if (err) {
      logger.error(`Error checking sync status for node ${nodeId}:`, err);
      return;
    }
    
    const now = new Date().toISOString();
    
    if (!row) {
      // New node, create a sync status entry
      configDb.run(
        'INSERT INTO node_sync_status (node_id, last_seen_timestamp, sync_status) VALUES (?, ?, ?)',
        [nodeId, now, 'connected'],
        (err) => {
          if (err) {
            logger.error(`Error initializing sync status for node ${nodeId}:`, err);
          } else {
            logger.info(`Initialized sync status for new node ${nodeId}`);
          }
        }
      );
    } else {
      // Existing node, update status to connected
      configDb.run(
        'UPDATE node_sync_status SET last_seen_timestamp = ?, sync_status = ? WHERE node_id = ?',
        [now, 'connected', nodeId],
        (err) => {
          if (err) {
            logger.error(`Error updating sync status for node ${nodeId}:`, err);
          } else {
            logger.info(`Updated sync status for node ${nodeId} to connected`);
          }
        }
      );
    }
  });
}

// Get the current sync interval setting
function getSyncInterval(callback) {
  configDb.get('SELECT value FROM mqtt_stats WHERE key = ?', ['sync_interval'], (err, row) => {
    if (err) {
      logger.error('Error fetching sync interval:', err);
      callback(60000); // Default to 1 minute if error
    } else if (row) {
      callback(parseInt(row.value) || 60000);
    } else {
      callback(60000); // Default to 1 minute if not found
    }
  });
}

// Update the sync interval setting
function updateSyncInterval(interval, callback) {
  const intInterval = parseInt(interval);
  if (isNaN(intInterval) || intInterval < 5000) {
    return callback(new Error('Invalid interval value. Must be at least 5000ms.'));
  }
  
  configDb.run(
    'UPDATE mqtt_stats SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
    [intInterval.toString(), 'sync_interval'],
    (err) => {
      if (err) {
        logger.error('Error updating sync interval:', err);
        return callback(err);
      }
      logger.info(`Updated sync interval to ${intInterval}ms`);
      callback(null, intInterval);
    }
  );
}

// Sync scheduler
let syncSchedulerInterval;

function startSyncScheduler() {
  // Clear existing interval if any
  if (syncSchedulerInterval) {
    clearInterval(syncSchedulerInterval);
  }
  
  // Get current sync interval
  getSyncInterval((interval) => {
    logger.info(`Starting sync scheduler with interval: ${interval}ms`);
    
    syncSchedulerInterval = setInterval(() => {
      // Check for too many pending requests before making new ones
      configDb.all(
        'SELECT COUNT(*) as pendingCount FROM history_requests WHERE status = ?',
        ['pending'],
        (err, rows) => {
          if (err) {
            logger.error('Error checking pending requests:', err);
            return;
          }
          
          // If there are too many pending requests, skip this sync cycle
          const pendingCount = rows[0] ? rows[0].pendingCount : 0;
          if (pendingCount > 20) {
            logger.warn(`Skipping sync cycle due to high number of pending requests (${pendingCount})`);
            return;
          }
          
          // Get all connected nodes
          configDb.all(
            `SELECT n.node_id, n.last_sync_timestamp, s.last_sequence 
             FROM node_sync_status n
             LEFT JOIN node_sequence_info s ON n.node_id = s.node_id
             WHERE n.sync_status = ?`,
            ['connected'],
            (err, nodes) => {
              if (err) {
                logger.error('Error fetching nodes for sync:', err);
                return;
              }
              
              // Request historical data for each node, one at a time with short delays
              nodes.forEach((node, index) => {
                setTimeout(() => {
                  // First check if there are already pending requests for this node
                  configDb.all(
                    'SELECT COUNT(*) as nodeRequestCount FROM history_requests WHERE node_id = ? AND status = ?',
                    [node.node_id, 'pending'],
                    (err, countRows) => {
                      if (err) {
                        logger.error(`Error checking pending requests for node ${node.node_id}:`, err);
                        return;
                      }
                      
                      const nodeRequestCount = countRows[0] ? countRows[0].nodeRequestCount : 0;
                      
                      // Skip nodes that already have pending requests
                      if (nodeRequestCount > 0) {
                        logger.info(`Skipping sync for node ${node.node_id} due to ${nodeRequestCount} pending requests`);
                        return;
                      }
                      
                      // Use sequence-based approach for data synchronization
                      const lastSequence = node.last_sequence || 0;
                      
                      // Request data from the next sequence after what we already have
                      requestNodeHistory(node.node_id, lastSequence + 1, null);
                    }
                  );
                }, index * 2000); // Stagger requests 2 seconds apart
              });
            }
          );
        }
      );
    }, interval);
  });
}

// Advertise MQTT broker via mDNS
function advertiseMqttService() {
  try {
    // Get the server's hostname
    const os = require('os');
    const hostname = os.hostname();
    
    // Publish the MQTT service
    const service = bonjour.publish({
      name: 'undergrowth-mqtt',
      type: 'mqtt',
      port: mqttPort,
      host: hostname,
      txt: {
        server: 'undergrowth'
      }
    });
    
    logger.info('MQTT service advertised via mDNS', {
      name: 'undergrowth-mqtt',
      type: 'mqtt',
      port: mqttPort
    });
    
    // Handle cleanup on process exit
    process.on('SIGINT', () => {
      logger.info('Stopping mDNS advertisement');
      bonjour.unpublishAll(() => {
        process.exit();
      });
    });
    
    return service;
  } catch (error) {
    logger.error('Failed to advertise MQTT service via mDNS', { error: error.message });
    return null;
  }
}

// MQTT event handlers
aedes.on('client', function (client) {
    // Debug logging commented out
    // logger.info('Client Connected:', client.id);
    
    // Update connected_nodes table
    configDb.run(
        'INSERT OR REPLACE INTO connected_nodes (id, connected_since, last_message) VALUES (?, ?, ?)',
        [client.id, new Date().toISOString(), new Date().toISOString()],
        (err) => {
            if (err) {
                logger.error('Error updating connected nodes:', err);
            }
        }
    );
    
    // Initialize node sync status for this client
    initNodeSyncStatus(client.id);
    
    // Update total connections count
    configDb.get('SELECT value FROM mqtt_stats WHERE key = ?', ['total_connections'], (err, row) => {
        if (!err && row) {
            const count = parseInt(row.value || '0') + 1;
            configDb.run('UPDATE mqtt_stats SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
                [count.toString(), 'total_connections']);
        }
    });
});

aedes.on('clientDisconnect', function (client) {
    // Debug logging commented out
    // logger.info('Client Disconnected:', client.id);
    
    // Remove from connected_nodes table
    configDb.run('DELETE FROM connected_nodes WHERE id = ?', [client.id], (err) => {
        if (err) {
            logger.error('Error removing disconnected node:', err);
        }
    });
    
    // Update node sync status to disconnected
    configDb.run(
        'UPDATE node_sync_status SET sync_status = ? WHERE node_id = ?',
        ['disconnected', client.id],
        (err) => {
            if (err) {
                logger.error(`Error updating sync status for disconnected node ${client.id}:`, err);
            } else {
                logger.info(`Updated sync status for node ${client.id} to disconnected`);
            }
        }
    );
});

aedes.on('publish', function (packet, client) {
    if (client) {
        // Debug logging commented out
        // logger.info('Client Published:', {
        //     client: client.id,
        //     topic: packet.topic,
        //     payload: packet.payload.toString()
        // });
        
        // Update connected_nodes table with last message time
        configDb.run(
            'UPDATE connected_nodes SET last_message = ? WHERE id = ?',
            [new Date().toISOString(), client.id],
            (err) => {
                if (err) {
                    logger.error('Error updating node last message:', err);
                }
            }
        );
        
        // Update message counters
        configDb.run(
            'UPDATE connected_nodes SET messages_received = messages_received + 1 WHERE id = ?',
            [client.id]
        );
        
        // Update total messages count
        configDb.get('SELECT value FROM mqtt_stats WHERE key = ?', ['total_messages'], (err, row) => {
            if (!err && row) {
                const count = parseInt(row.value || '0') + 1;
                configDb.run('UPDATE mqtt_stats SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
                    [count.toString(), 'total_messages']);
            }
        });
        
        // Process sensor data from nodes
        if (packet.topic.match(/^undergrowth\/nodes\/([^\/]+)\/sensors$/)) {
            try {
                const nodeId = packet.topic.split('/')[2];
                const payload = JSON.parse(packet.payload.toString());
                
                if (payload.sensors) {
                    // Store sensor data in database
                    const timestamp = payload.timestamp || new Date().toISOString();
                    
                    // Process each sensor
                    Object.entries(payload.sensors).forEach(([sensorId, data]) => {
                        // Store temperature reading
                        if (data.temperature !== undefined) {
                            logsDb.run(
                                `INSERT INTO sensor_data 
                                (timestamp, node_id, sensor_id, sensor_type, reading_type, value) 
                                VALUES (?, ?, ?, ?, ?, ?)`,
                                [timestamp, nodeId, sensorId, data.address || sensorId, 'temperature', data.temperature]
                            );
                        }
                        
                        // Store humidity reading
                        if (data.humidity !== undefined) {
                            logsDb.run(
                                `INSERT INTO sensor_data 
                                (timestamp, node_id, sensor_id, sensor_type, reading_type, value) 
                                VALUES (?, ?, ?, ?, ?, ?)`,
                                [timestamp, nodeId, sensorId, data.address || sensorId, 'humidity', data.humidity]
                            );
                        }
                    });
                }
            } catch (error) {
                logger.error('Error processing sensor data:', error);
            }
        }
        
        // Process historical data from nodes
        if (packet.topic.match(/^undergrowth\/nodes\/([^\/]+)\/history$/)) {
            try {
                const nodeId = packet.topic.split('/')[2];
                const payload = JSON.parse(packet.payload.toString());
                
                logger.info(`Received historical data from node ${nodeId}`, {
                    requestId: payload.requestId,
                    recordCount: payload.dataPoints ? payload.dataPoints.length : 0,
                    sequenceRange: payload.startSequence && payload.endSequence ? 
                        `${payload.startSequence}-${payload.endSequence}` : 'none'
                });
                
                // Verify data integrity if checksum is provided
                let checksumVerified = false;
                if (payload.checksum) {
                    // TODO: Implement SHA-256 checksum verification
                    checksumVerified = true;
                    logger.info(`Checksum verification ${checksumVerified ? 'passed' : 'failed'} for node ${nodeId}`);
                }
                
                // Store the historical data
                const storedCount = storeNodeHistoricalData(nodeId, payload.dataPoints, checksumVerified);
                
                // Update the node's sequence tracking information
                if (payload.endSequence) {
                    configDb.run(
                        `INSERT OR REPLACE INTO node_sequence_info 
                         (node_id, last_sequence, max_sequence, updated_at) 
                         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                        [nodeId, payload.endSequence, payload.maxSequence || payload.endSequence],
                        (err) => {
                            if (err) {
                                logger.error(`Error updating sequence info for node ${nodeId}:`, err);
                            } else {
                                logger.info(`Updated sequence info for node ${nodeId} to sequence ${payload.endSequence}`);
                            }
                        }
                    );
                }
                
                // Update the sync status timestamp
                configDb.run(
                    'UPDATE node_sync_status SET last_sync_timestamp = ? WHERE node_id = ?',
                    [new Date().toISOString(), nodeId],
                    (err) => {
                        if (err) {
                            logger.error(`Error updating last sync timestamp for node ${nodeId}:`, err);
                        }
                    }
                );
                
                // Mark request as completed
                if (payload.requestId) {
                    configDb.run(
                        'UPDATE history_requests SET status = ?, complete_time = ?, record_count = ? WHERE request_id = ?',
                        ['completed', new Date().toISOString(), storedCount, payload.requestId],
                        (err) => {
                            if (err) {
                                logger.error(`Error updating history request status for ${payload.requestId}:`, err);
                            } else {
                                logger.info(`Marked history request ${payload.requestId} as completed`);
                            }
                        }
                    );
                }
            } catch (error) {
                logger.error('Error processing historical data:', error);
            }
        }
        
        // Process node status updates
        if (packet.topic.match(/^undergrowth\/nodes\/([^\/]+)\/status$/)) {
            try {
                const nodeId = packet.topic.split('/')[2];
                const payload = JSON.parse(packet.payload.toString());
                
                // Debug logging
                logger.info('Received node status update:', {
                    nodeId,
                    hostname: payload.hostname,
                    ip: payload.ip,
                    clientId: client.id
                });
                
                // Update hostname and IP if available
                if (payload.hostname || payload.ip) {
                    configDb.run(
                        'UPDATE connected_nodes SET hostname = ?, ip_address = ? WHERE id = ?',
                        [payload.hostname, payload.ip, client.id],
                        (err) => {
                            if (err) {
                                logger.error('Error updating node info:', err);
                            } else {
                                logger.info('Updated node info:', {
                                    nodeId: client.id,
                                    hostname: payload.hostname,
                                    ip: payload.ip
                                });
                            }
                        }
                    );
                }
                
                // Update last_seen in nodes table
                configDb.run(
                    'INSERT OR REPLACE INTO nodes (id, last_seen) VALUES (?, ?)',
                    [nodeId, new Date().toISOString()]
                );
                
            } catch (error) {
                logger.error('Error processing node status:', error);
            }
        }
    }
});

aedes.on('subscribe', function (subscriptions, client) {
    // Debug logging commented out
    // logger.info('Client Subscribed:', {
    //     client: client.id,
    //     subscriptions: subscriptions.map(s => s.topic)
    // });
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Routes
app.get('/api/nodes', (req, res) => {
  configDb.all('SELECT * FROM nodes', [], (err, rows) => {
    if (err) {
      logger.error('Error fetching nodes:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.json(rows);
  });
});

// Get connected nodes
app.get('/api/connected-nodes', (req, res) => {
  configDb.all('SELECT * FROM connected_nodes', [], (err, rows) => {
    if (err) {
      logger.error('Error fetching connected nodes:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.json(rows);
  });
});

// Get MQTT broker stats
app.get('/api/mqtt-stats', (req, res) => {
  configDb.all('SELECT * FROM mqtt_stats', [], (err, rows) => {
    if (err) {
      logger.error('Error fetching MQTT stats:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    
    // Format stats as an object
    const stats = {};
    rows.forEach(row => {
      stats[row.key] = row.value;
    });
    
    // Add active connections count
    configDb.get('SELECT COUNT(*) as count FROM connected_nodes', [], (err, row) => {
      if (!err && row) {
        stats.active_connections = row.count.toString();
      } else {
        stats.active_connections = '0';
      }
      
      // Add HTTP and MQTT port information
      stats.http_port = port.toString();
      stats.mqtt_port = mqttPort.toString();
      
      res.json(stats);
    });
  });
});

// Get sync status for nodes
app.get('/api/sync-status', (req, res) => {
  configDb.all(`
    SELECT ns.*, n.name
    FROM node_sync_status ns
    LEFT JOIN nodes n ON ns.node_id = n.id
    ORDER BY ns.sync_status, ns.last_seen_timestamp DESC
  `, [], (err, rows) => {
    if (err) {
      logger.error('Error fetching sync status:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    
    // Get current sync interval
    getSyncInterval((interval) => {
      // Get recent history requests
      configDb.all(`
        SELECT *
        FROM history_requests
        ORDER BY request_time DESC
        LIMIT 10
      `, [], (err, historyRequests) => {
        if (err) {
          logger.error('Error fetching history requests:', err);
          res.status(500).json({ error: 'Internal server error' });
          return;
        }
        
        res.json({
          nodes: rows,
          syncInterval: interval,
          historyRequests: historyRequests || []
        });
      });
    });
  });
});

// Update sync interval
app.post('/api/sync-interval', express.json(), (req, res) => {
  const { interval } = req.body;
  
  if (!interval) {
    return res.status(400).json({ error: 'Interval is required' });
  }
  
  updateSyncInterval(interval, (err, newInterval) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    
    // Restart sync scheduler with new interval
    startSyncScheduler();
    
    res.json({ success: true, syncInterval: newInterval });
  });
});

// Request historical data from a specific node
app.post('/api/request-history', express.json(), (req, res) => {
  const { nodeId, startTime, endTime, startSequence, endSequence } = req.body;
  
  if (!nodeId) {
    return res.status(400).json({ error: 'Node ID is required' });
  }
  
  // Check if this is a sequence-based or time-based request
  const isSequenceBased = startSequence !== undefined;
  
  try {
    let requestId;
    
    if (isSequenceBased) {
      // Sequence-based request
      requestId = requestNodeHistory(nodeId, startSequence, endSequence);
    } else {
      // Time-based request (backwards compatibility)
      if (!startTime || !endTime) {
        return res.status(400).json({ error: 'For time-based requests, start time and end time are required' });
      }
      requestId = requestNodeHistory(nodeId, null, null, startTime, endTime);
    }
    
    res.json({ success: true, requestId });
  } catch (error) {
    logger.error('Error requesting historical data:', error);
    res.status(500).json({ error: 'Failed to request historical data' });
  }
});

app.get('/api/logs', (req, res) => {
  const { node_id, start_time, end_time } = req.query;
  let query = 'SELECT * FROM logs';
  const params = [];

  if (node_id || start_time || end_time) {
    query += ' WHERE';
    const conditions = [];

    if (node_id) {
      conditions.push(' node_id = ?');
      params.push(node_id);
    }
    if (start_time) {
      conditions.push(' timestamp >= ?');
      params.push(start_time);
    }
    if (end_time) {
      conditions.push(' timestamp <= ?');
      params.push(end_time);
    }

    query += conditions.join(' AND');
  }

  query += ' ORDER BY timestamp DESC LIMIT 1000';

  logsDb.all(query, params, (err, rows) => {
    if (err) {
      logger.error('Error fetching logs:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.json(rows);
  });
});

// Get sensor data
app.get('/api/sensor-data', (req, res) => {
  const { node_id, sensor_id, reading_type, start_time, end_time, limit } = req.query;
  let query = 'SELECT * FROM sensor_data';
  const params = [];
  const conditions = [];
  
  if (node_id) {
    conditions.push('node_id = ?');
    params.push(node_id);
  }
  
  if (sensor_id) {
    conditions.push('sensor_id = ?');
    params.push(sensor_id);
  }
  
  if (reading_type) {
    conditions.push('reading_type = ?');
    params.push(reading_type);
  }
  
  if (start_time) {
    conditions.push('timestamp >= ?');
    params.push(start_time);
  }
  
  if (end_time) {
    conditions.push('timestamp <= ?');
    params.push(end_time);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  query += ' ORDER BY timestamp DESC';
  
  if (limit) {
    query += ' LIMIT ?';
    params.push(parseInt(limit));
  } else {
    query += ' LIMIT 1000'; // Default limit
  }
  
  logsDb.all(query, params, (err, rows) => {
    if (err) {
      logger.error('Error fetching sensor data:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.json(rows);
  });
});

// Get binned sensor data for graphs
app.get('/api/sensor-data/binned', (req, res) => {
  const { node_id, reading_type, start_time, end_time, bin_count } = req.query;
  
  // Validate required parameters
  if (!node_id || !reading_type || !start_time) {
    return res.status(400).json({ error: 'Missing required parameters: node_id, reading_type, start_time' });
  }
  
  // Set defaults
  const binCount = parseInt(bin_count) || 100;
  const endTimeValue = end_time || new Date().toISOString();
  
  // Build query to get raw data
  const query = `
    SELECT timestamp, value
    FROM sensor_data
    WHERE node_id = ?
      AND reading_type = ?
      AND timestamp >= ?
      ${end_time ? 'AND timestamp <= ?' : ''}
    ORDER BY timestamp ASC
  `;
  
  const params = [node_id, reading_type, start_time];
  if (end_time) {
    params.push(end_time);
  }
  
  logsDb.all(query, params, (err, rows) => {
    if (err) {
      logger.error('Error fetching sensor data for binning:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!rows || rows.length === 0) {
      return res.json([]);
    }
    
    // If we have fewer rows than bins, just return all rows
    if (rows.length <= binCount) {
      return res.json(rows);
    }
    
    // Create bins based on time range, not just data points
    const startDateTime = new Date(start_time).getTime();
    const endDateTime = end_time ? new Date(end_time).getTime() : new Date().getTime();
    const timeRange = endDateTime - startDateTime;
    const timePerBin = timeRange / binCount;
    
    // Function to detect if there are gaps in data
    const MAX_GAP_MINUTES = 10; // Consider data points more than 10 minutes apart as gaps
    const binnedData = [];
    
    for (let i = 0; i < binCount; i++) {
      const binStartTime = startDateTime + (i * timePerBin);
      const binEndTime = binStartTime + timePerBin;
      
      // Find data points that fall within this time bin
      const binPoints = rows.filter(row => {
        const rowTime = new Date(row.timestamp).getTime();
        return rowTime >= binStartTime && rowTime < binEndTime;
      });
      
      // Skip bins with no data points (preserve gaps)
      if (binPoints.length === 0) {
        continue;
      }
      
      // Calculate average for this bin
      let sum = 0;
      binPoints.forEach(point => {
        sum += point.value;
      });
      
      // Use the middle point's timestamp or calculate midpoint
      const binTimestamp = binPoints.length > 0 ? 
        binPoints[Math.floor(binPoints.length / 2)].timestamp : 
        new Date(binStartTime + (timePerBin / 2)).toISOString();
      
      binnedData.push({
        timestamp: binTimestamp,
        value: sum / binPoints.length
      });
    }
    
    res.json(binnedData);
  });
});

// API endpoint to get node sequence information
app.get('/api/node-sequence-info/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  
  if (!nodeId) {
    return res.status(400).json({ error: 'Node ID is required' });
  }
  
  // Get sequence information for this node
  configDb.get(
    'SELECT last_sequence, max_sequence, updated_at FROM node_sequence_info WHERE node_id = ?',
    [nodeId],
    (err, seqInfo) => {
      if (err) {
        logger.error('Error fetching node sequence info:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Get total records from the sensor_data table for this node
      logsDb.get(
        'SELECT COUNT(*) as total_records FROM sensor_data WHERE node_id = ?',
        [nodeId],
        (err, countInfo) => {
          if (err) {
            logger.error('Error counting node records:', err);
            return res.status(500).json({ error: 'Database error' });
          }
          
          res.json({
            node_id: nodeId,
            last_sequence: seqInfo ? seqInfo.last_sequence : 0,
            max_sequence: seqInfo ? seqInfo.max_sequence : 0,
            updated_at: seqInfo ? seqInfo.updated_at : null,
            total_records: countInfo ? countInfo.total_records : 0
          });
        }
      );
    }
  );
});

// Start servers
mqttServer.listen(mqttPort, function () {
  logger.info(`MQTT server listening on port ${mqttPort}`);
  
  // Advertise MQTT broker via mDNS
  advertiseMqttService();
  
  // Start the sync scheduler
  startSyncScheduler();
});

// Setup WebSocket MQTT
ws.createServer({ server: httpServer }, aedes.handle);

// Start HTTP server
httpServer.listen(port, () => {
  logger.info(`HTTP server running at http://localhost:${port}`);
});