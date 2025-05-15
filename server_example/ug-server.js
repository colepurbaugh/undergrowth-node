const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const aedes = require('aedes')();
const { createServer } = require('net');
const { Bonjour } = require('bonjour-service');
const bonjour = new Bonjour();

// Initialize Express app
const app = express();
const httpServer = require('http').createServer(app);
const port = process.env.PORT || 3000;
const mqttPort = process.env.MQTT_PORT || 1883;

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! Server will continue running:', err);
  logger.error('Uncaught exception', { 
    error: err.message,
    stack: err.stack
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION! Server will continue running:', reason);
  logger.error('Unhandled promise rejection', { 
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

// Add CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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
const logsDb = new sqlite3.Database('./database/ug-logs.db');
const nodeDataDb = new sqlite3.Database('./database/ug-node-data.db');

// Initialize Socket.IO for real-time communication
const io = require('socket.io')(httpServer, {
  path: '/socket.io',
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  },
  transports: ['websocket', 'polling'],  // Use both websocket and polling
  pingTimeout: 20000,
  pingInterval: 25000,
  allowEIO3: true, // Allow Engine.IO 3 clients
  maxHttpBufferSize: 1e8 // Increase buffer size
});

// Add Socket.IO error logging
io.engine.on('connection_error', (err) => {
  console.error('Socket.IO connection error:', err);
  logger.error('Socket.IO connection error', { 
    code: err.code, 
    message: err.message,
    transport: err.transport,
    details: err
  });
});

// Function to log sync process events (both to database and broadcast to UI)
function logSyncEvent(message, level = 'info', nodeId = null, context = null) {
  // Map any non-standard log levels to standard Winston levels
  const validLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
  const mappedLevel = validLevels.includes(level) ? level : 'info';
  
  // Log to Winston
  logger[mappedLevel](message, { nodeId, context });
  
  // Store in logs database
  const timestamp = new Date().toISOString();
  logsDb.run(
    'INSERT INTO logs (timestamp, node_id, level, message, context) VALUES (?, ?, ?, ?, ?)',
    [timestamp, nodeId, level, message, context ? JSON.stringify(context) : null]
  );
  
  // Broadcast to connected clients for UI updates
  io.emit('serverEvent', {
    timestamp,
    level,
    nodeId,
    message,
    context
  });
}

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
  
  // Add a config setting for batch size
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['sync_batch_size', '1000']);
  
  // Add global sequence counter for tracking sequence IDs across all nodes
  configDb.run('INSERT OR IGNORE INTO mqtt_stats (key, value) VALUES (?, ?)', ['global_sequence', '1']);
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
});

nodeDataDb.serialize(() => {
  // Create sensor_data table in the node data database
  nodeDataDb.run(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TIMESTAMP,
      node_id TEXT,
      sensor_id TEXT,
      sensor_type TEXT,
      reading_type TEXT,
      value REAL,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sequence_id INTEGER,
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
function requestNodeHistory(nodeId, startSequence = 0, endSequence = null, startTime = null, endTime = null, batchSize = 1000) {
  const requestId = generateRequestId();
  
  // Create request object based on whether we're using sequence or time
  const isSequenceBased = startSequence !== null && startSequence !== undefined;
  const request = {
    requestId,
    startSequence: isSequenceBased ? startSequence : 0
  };
  
  // Add either end sequence or time range parameters
  if (isSequenceBased) {
    // If no endSequence provided, use startSequence + batchSize to request a batch
    if (!endSequence) {
      endSequence = startSequence + batchSize;
    }
    request.endSequence = endSequence;
    
    logger.info(`Requesting historical data from node ${nodeId} using sequence range`, {
      requestId,
      startSequence,
      endSequence
    });
    
    logSyncEvent(
      `Requesting data from node ${nodeId} (sequences ${startSequence} to ${endSequence || 'latest'})`, 
      'info', 
      nodeId, 
      { requestId, startSequence, endSequence }
    );
  } else {
    // Fallback to time-based for backward compatibility
    request.startTime = startTime || '2000-01-01T00:00:00Z';
    request.endTime = endTime || new Date().toISOString();
    
    logger.info(`Requesting historical data from node ${nodeId} using time range`, {
      requestId,
      startTime: request.startTime,
      endTime: request.endTime
    });
    
    logSyncEvent(
      `Requesting data from node ${nodeId} (time ${request.startTime} to ${request.endTime})`, 
      'info', 
      nodeId, 
      { requestId, startTime: request.startTime, endTime: request.endTime }
    );
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
        logSyncEvent('Error storing history request in database', 'error', nodeId, { requestId });
      } else {
        logSyncEvent('History request stored in database', 'info', nodeId, { requestId });
      }
    }
  );
  
  // Publish request to node
  aedes.publish({
    topic: `undergrowth/server/requests/${nodeId}/history`,
    payload: JSON.stringify(request),
    qos: 1
  });
  
  logSyncEvent('Data request published to node', 'info', nodeId, { 
    requestId, 
    topic: `undergrowth/server/requests/${nodeId}/history` 
  });
  
  // Set a timeout to mark the request as failed if not completed in 2 minutes
  setTimeout(() => {
    configDb.get('SELECT status FROM history_requests WHERE request_id = ?', [requestId], (err, row) => {
      if (!err && row && row.status === 'pending') {
        logger.warn(`History request ${requestId} for node ${nodeId} timed out`);
        logSyncEvent('Data request timed out after 2 minutes', 'warn', nodeId, { requestId });
        
        configDb.run(
          'UPDATE history_requests SET status = ?, complete_time = ? WHERE request_id = ?',
          ['timeout', new Date().toISOString(), requestId],
          (err) => {
            if (err) {
              logger.error(`Error marking history request as timed out: ${requestId}`, err);
              logSyncEvent('Error updating request timeout status', 'error', nodeId, { requestId });
            }
          }
        );
      }
    });
  }, 120000); // 2 minute timeout
  
  return requestId;
}

// Execute a SQLite statement with error handling
function executeSqlWithErrorHandling(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

// Execute a transaction safely
async function executeTransaction(db, operations) {
  let transactionStarted = false;
  
  try {
    // Begin transaction
    await executeSqlWithErrorHandling(db, 'BEGIN TRANSACTION');
    transactionStarted = true;
    
    // Execute all operations
    for (const operation of operations) {
      await operation();
    }
    
    // Commit transaction
    await executeSqlWithErrorHandling(db, 'COMMIT');
    return true;
  } catch (error) {
    logger.error('Transaction error:', error);
    
    // Only attempt rollback if transaction was started
    if (transactionStarted) {
      try {
        await executeSqlWithErrorHandling(db, 'ROLLBACK');
      } catch (rollbackError) {
        logger.error('Error rolling back transaction:', rollbackError);
      }
    }
    
    throw error;
  }
}

// Store historical sensor data from node response
function storeNodeHistoricalData(nodeId, dataPoints, checksumVerified = false, requestId = null) {
  if (!dataPoints || !Array.isArray(dataPoints) || dataPoints.length === 0) {
    logger.warn(`Received empty data points from node ${nodeId}`);
    logSyncEvent('Received empty data package from node', 'warn', nodeId, { requestId });
    return 0;
  }
  
  logger.info(`Processing ${dataPoints.length} historical data points from node ${nodeId}`);
  logSyncEvent(`Processing ${dataPoints.length} data points from node`, 'info', nodeId, { 
    requestId, 
    recordCount: dataPoints.length 
  });
  
  let storedCount = 0;
  
  return new Promise((resolve, reject) => {
    // Add sequence_id field to sensor_data table if it doesn't exist
    nodeDataDb.all("PRAGMA table_info(sensor_data)", [], (err, rows) => {
      if (err) {
        logger.error('Error checking sensor_data table schema:', err);
        logSyncEvent('Error checking database schema', 'error', nodeId, { requestId });
        return reject(err);
      }
      
      // Check if sequence_id column exists
      const hasSequenceId = rows && rows.some(row => row.name === 'sequence_id');
      
      if (!hasSequenceId) {
        logger.info('Adding sequence_id column to sensor_data table');
        nodeDataDb.run('ALTER TABLE sensor_data ADD COLUMN sequence_id INTEGER');
      }
      
      // Create a statement to be executed for each data point
      const stmt = nodeDataDb.prepare(`
        INSERT OR IGNORE INTO sensor_data
        (timestamp, node_id, sensor_id, sensor_type, reading_type, value, sequence_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      // Log sensor types found in the data
      const sensorTypes = new Set();
      dataPoints.forEach(point => {
        if (point.sensorId) {
          sensorTypes.add(`${point.sensorId} (${point.type})`);
        }
      });
      if (sensorTypes.size > 0) {
        logger.info(`Processing data for ${nodeId} with sensors: ${Array.from(sensorTypes).join(', ')}`);
      }
      
      // Begin transaction
      nodeDataDb.run('BEGIN TRANSACTION', (transErr) => {
        if (transErr) {
          logger.error('Error starting transaction:', transErr);
          return reject(transErr);
        }
        
        try {
          let insertErrors = 0;
          let uniqueConstraintErrors = 0;
          
          dataPoints.forEach(point => {
            // Log a sample of the data being inserted (first few records only)
            if (dataPoints.indexOf(point) < 3) {
              logger.info(`Sample data point: ${JSON.stringify(point)}`);
              logSyncEvent(`Sample data: ${JSON.stringify(point)}`, 'info', nodeId, { requestId });
            }
            
            try {
              stmt.run(
                point.timestamp,
                nodeId,
                point.sensorId,
                point.sensorType || point.sensorId,
                point.type || point.readingType, // Support both formats
                point.value,
                point.sequence_id || null,
                function(err) {
                  if (err) {
                    if (err.code === 'SQLITE_CONSTRAINT') {
                      uniqueConstraintErrors++;
                    } else {
                      insertErrors++;
                      if (insertErrors < 5) { // Log only first few errors to avoid flooding
                        logger.error(`Error inserting data point: ${JSON.stringify(point)}`, err);
                        logSyncEvent(`Error inserting data: ${err.message}`, 'error', nodeId, { requestId, dataPoint: point });
                      }
                    }
                  } else if (this.changes > 0) {
                    storedCount++;
                  }
                }
              );
            } catch (runErr) {
              insertErrors++;
              logger.error(`Error running prepared statement: ${runErr.message}`);
            }
          });
          
          // Finalize statement and commit transaction
          stmt.finalize((finalizeErr) => {
            if (finalizeErr) {
              logger.error('Error finalizing statement:', finalizeErr);
              
              // Attempt rollback
              nodeDataDb.run('ROLLBACK', (rollbackErr) => {
                if (rollbackErr) {
                  logger.error('Error rolling back transaction:', rollbackErr);
                }
                reject(finalizeErr);
              });
              return;
            }
            
            // Commit the transaction
            nodeDataDb.run('COMMIT', (commitErr) => {
              if (commitErr) {
                logger.error('Error committing transaction:', commitErr);
                
                // Attempt rollback
                nodeDataDb.run('ROLLBACK', (rollbackErr) => {
                  if (rollbackErr) {
                    logger.error('Error rolling back transaction:', rollbackErr);
                  }
                  reject(commitErr);
                });
                return;
              }
              
              if (uniqueConstraintErrors > 0) {
                logger.info(`${uniqueConstraintErrors} records were duplicates (already stored)`);
                logSyncEvent(`${uniqueConstraintErrors} records were duplicates`, 'info', nodeId, { requestId });
              }
              
              if (insertErrors > 0) {
                logger.error(`${insertErrors} errors occurred while storing data`);
                logSyncEvent(`${insertErrors} errors occurred while storing data`, 'error', nodeId, { requestId });
              }
              
              logger.info(`Successfully stored ${storedCount} historical data points from node ${nodeId}`);
              logSyncEvent(`Successfully stored ${storedCount} data points from node`, 'info', nodeId, { 
                requestId, 
                storedCount,
                totalCount: dataPoints.length
              });
              
              resolve(storedCount);
            });
          });
        } catch (err) {
          // Handle any errors during processing
          logger.error(`Error processing data points: ${err.message}`);
          
          // Attempt rollback
          nodeDataDb.run('ROLLBACK', (rollbackErr) => {
            if (rollbackErr) {
              logger.error('Error rolling back transaction:', rollbackErr);
            }
            reject(err);
          });
        }
      });
    });
  }).catch(err => {
    logger.error(`Error storing historical data from node ${nodeId}:`, err);
    logSyncEvent('Error storing node data in database', 'error', nodeId, { 
      requestId, 
      error: err.message 
    });
    return 0;
  });
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

// Get the sync batch size setting
function getSyncBatchSize(callback) {
  configDb.get('SELECT value FROM mqtt_stats WHERE key = ?', ['sync_batch_size'], (err, row) => {
    if (err) {
      logger.error('Error fetching sync batch size:', err);
      callback(1000); // Default to 1000 if error
    } else if (row) {
      callback(parseInt(row.value) || 1000);
    } else {
      callback(1000); // Default to 1000 if not found
    }
  });
}

// Update the sync batch size setting
function updateSyncBatchSize(batchSize, callback) {
  const intBatchSize = parseInt(batchSize);
  if (isNaN(intBatchSize) || intBatchSize < 1) {
    return callback(new Error('Invalid batch size value. Must be at least 1.'));
  }
  
  configDb.run(
    'UPDATE mqtt_stats SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
    [intBatchSize.toString(), 'sync_batch_size'],
    (err) => {
      if (err) {
        logger.error('Error updating sync batch size:', err);
        return callback(err);
      }
      logger.info(`Updated sync batch size to ${intBatchSize}`);
      callback(null, intBatchSize);
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
    // Get batch size
    getSyncBatchSize((batchSize) => {
      logger.info(`Starting sync scheduler with interval: ${interval}ms and batch size: ${batchSize}`);
      logSyncEvent(`Starting sync scheduler (interval: ${Math.round(interval/1000)}s, batch size: ${batchSize})`, 'info');
      
      syncSchedulerInterval = setInterval(() => {
        // Log scheduler run
        logSyncEvent(`Running scheduled data sync check`, 'info');
        
        // Clean up excess pending requests from previous sync attempts
        cleanupExcessPendingRequests();
        
        // Check for too many pending requests before making new ones
        configDb.all(
          'SELECT COUNT(*) as pendingCount FROM history_requests WHERE status = ?',
          ['pending'],
          (err, rows) => {
            if (err) {
              logger.error('Error checking pending requests:', err);
              logSyncEvent('Error checking pending requests', 'error', null, { error: err.message });
              return;
            }
            
            // If there are too many pending requests, skip this sync cycle
            const pendingCount = rows[0] ? rows[0].pendingCount : 0;
            const maxPendingRequests = 50; // Allow more concurrent requests
            
            if (pendingCount > maxPendingRequests) {
              logger.warn(`Skipping sync cycle due to high number of pending requests (${pendingCount})`);
              logSyncEvent(`Skipping sync cycle (${pendingCount} pending requests)`, 'warn');
              return;
            }
            
            // Get all connected nodes
            configDb.all(
              `SELECT n.node_id, n.last_sync_timestamp, s.last_sequence, s.max_sequence 
               FROM node_sync_status n
               LEFT JOIN node_sequence_info s ON n.node_id = s.node_id
               WHERE n.sync_status = ?`,
              ['connected'],
              (err, nodes) => {
                if (err) {
                  logger.error('Error fetching nodes for sync:', err);
                  logSyncEvent('Error fetching connected nodes for sync', 'error', null, { error: err.message });
                  return;
                }
                
                if (nodes.length === 0) {
                  logSyncEvent('No connected nodes to sync with', 'info');
                  return;
                }
                
                logSyncEvent(`Found ${nodes.length} connected nodes to check for sync`, 'info');
                
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
                          logSyncEvent('Error checking node pending requests', 'error', node.node_id, { error: err.message });
                          return;
                        }
                        
                        const nodeRequestCount = countRows[0] ? countRows[0].nodeRequestCount : 0;
                        const maxNodePendingRequests = 2; // Allow up to 2 pending requests per node
                        
                        // Skip nodes that already have too many pending requests
                        if (nodeRequestCount >= maxNodePendingRequests) {
                          logger.info(`Skipping sync for node ${node.node_id} due to ${nodeRequestCount} pending requests`);
                          logSyncEvent(`Skipping sync for node (has ${nodeRequestCount} pending requests)`, 'info', node.node_id);
                          return;
                        }
                        
                        // Use sequence-based approach for data synchronization
                        const lastSequence = node.last_sequence || 0;
                        const maxSequence = node.max_sequence || 0;
                        
                        // Calculate progress percentage if we know the max sequence
                        let progressInfo = '';
                        if (maxSequence > 0) {
                          const progressPct = Math.min(100, Math.round((lastSequence / maxSequence) * 100));
                          progressInfo = ` (${progressPct}% complete)`;
                        }
                        
                        logSyncEvent(`Initiating sync from sequence ${lastSequence + 1}${progressInfo}`, 'info', node.node_id);
                        
                        // Request data from the next sequence after what we already have, with batch size
                        requestNodeHistory(node.node_id, lastSequence + 1, null, null, null, batchSize);
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
    
    // Log the connection event
    logSyncEvent(`Node ${client.id} connected to server`, 'info', client.id);
    
    // Update connected_nodes table
    configDb.run(
        'INSERT OR REPLACE INTO connected_nodes (id, connected_since, last_message) VALUES (?, ?, ?)',
        [client.id, new Date().toISOString(), new Date().toISOString()],
        (err) => {
            if (err) {
                logger.error('Error updating connected nodes:', err);
                logSyncEvent('Error updating connected nodes database', 'error', client.id);
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
    
    // Log the disconnection event
    logSyncEvent(`Node ${client.id} disconnected from server`, 'info', client.id);
    
    // Remove from connected_nodes table
    configDb.run('DELETE FROM connected_nodes WHERE id = ?', [client.id], (err) => {
        if (err) {
            logger.error('Error removing disconnected node:', err);
            logSyncEvent('Error updating disconnected node in database', 'error', client.id);
        }
    });
    
    // Update node sync status to disconnected
    configDb.run(
        'UPDATE node_sync_status SET sync_status = ? WHERE node_id = ?',
        ['disconnected', client.id],
        (err) => {
            if (err) {
                logger.error(`Error updating sync status for disconnected node ${client.id}:`, err);
                logSyncEvent('Error updating sync status for disconnected node', 'error', client.id);
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
                    
                    // Get the next sequence ID for this batch of readings
                    configDb.get('SELECT value FROM mqtt_stats WHERE key = ?', ['global_sequence'], (err, row) => {
                        let currentSequence = 1;
                        if (!err && row) {
                            currentSequence = parseInt(row.value) || 1;
                        }
                        
                        // Process each sensor
                        Object.entries(payload.sensors).forEach(([sensorId, data]) => {
                            // Get sensor metadata if available
                            const sensorType = data.type || 'unknown';
                            const sensorAddress = data.address || 'unknown';
                            const sensorName = data.name || sensorId;
                            
                            // Store temperature reading with sequence ID
                            if (data.temperature !== undefined) {
                                currentSequence++;
                                nodeDataDb.run(
                                    `INSERT INTO sensor_data 
                                    (timestamp, node_id, sensor_id, sensor_type, reading_type, value, sequence_id) 
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                    [timestamp, nodeId, sensorId, sensorAddress, 'temperature', data.temperature, currentSequence]
                                );
                            }
                            
                            // Store humidity reading with sequence ID
                            if (data.humidity !== undefined) {
                                currentSequence++;
                                nodeDataDb.run(
                                    `INSERT INTO sensor_data 
                                    (timestamp, node_id, sensor_id, sensor_type, reading_type, value, sequence_id) 
                                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                                    [timestamp, nodeId, sensorId, sensorAddress, 'humidity', data.humidity, currentSequence]
                                );
                            }
                            
                            // Log receipt of sensor data
                            logger.debug(`Received data from ${nodeId} sensor ${sensorId} (${sensorType} at ${sensorAddress}): temp=${data.temperature}°F, humidity=${data.humidity}%`);
                        });
                        
                        // Update the global sequence counter
                        configDb.run('UPDATE mqtt_stats SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
                            [currentSequence.toString(), 'global_sequence'], (err) => {
                            if (err) {
                                logger.error('Error updating global sequence:', err);
                            }
                        });
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
                
                // Log historical data receipt
                logSyncEvent(
                    `Received data package from node with ${payload.dataPoints ? payload.dataPoints.length : 0} records`, 
                    'info', 
                    nodeId, 
                    {
                        requestId: payload.requestId,
                        startSequence: payload.startSequence,
                        endSequence: payload.endSequence,
                        recordCount: payload.dataPoints ? payload.dataPoints.length : 0
                    }
                );
                
                // Verify data integrity if checksum is provided
                let checksumVerified = false;
                if (payload.checksum) {
                    // TODO: Implement SHA-256 checksum verification
                    checksumVerified = true;
                    logger.info(`Checksum verification ${checksumVerified ? 'passed' : 'failed'} for node ${nodeId}`);
                }
                
                // Store the historical data
                storeNodeHistoricalData(nodeId, payload.dataPoints, checksumVerified, payload.requestId)
                    .then(storedCount => {
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
                                        logSyncEvent('Error updating sequence tracking info', 'error', nodeId, {
                                            requestId: payload.requestId,
                                            lastSequence: payload.endSequence
                                        });
                                    } else {
                                        logger.info(`Updated sequence info for node ${nodeId} to sequence ${payload.endSequence}`);
                                        logSyncEvent(
                                            `Updated node sync progress to sequence ${payload.endSequence}`, 
                                            'success', 
                                            nodeId, 
                                            {
                                                requestId: payload.requestId,
                                                lastSequence: payload.endSequence,
                                                maxSequence: payload.maxSequence || payload.endSequence
                                            }
                                        );
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
                                    logSyncEvent('Error updating last sync timestamp', 'error', nodeId, {
                                        requestId: payload.requestId
                                    });
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
                                        logSyncEvent('Error marking request as completed', 'error', nodeId, {
                                            requestId: payload.requestId
                                        });
                                    } else {
                                        logger.info(`Marked history request ${payload.requestId} as completed`);
                                        logSyncEvent(
                                            `Sync request completed successfully`, 
                                            'info', 
                                            nodeId, 
                                            {
                                                requestId: payload.requestId,
                                                recordCount: storedCount
                                            }
                                        );

                                        // Summarize sensor data received
                                        try {
                                            // Count data points per sensor and reading type
                                            const sensorSummary = {};
                                            if (payload.dataPoints && Array.isArray(payload.dataPoints)) {
                                                payload.dataPoints.forEach(point => {
                                                    const sensorKey = `${point.sensorId || 'unknown'}_${point.type || 'unknown'}`;
                                                    if (!sensorSummary[sensorKey]) {
                                                        sensorSummary[sensorKey] = {
                                                            sensorId: point.sensorId,
                                                            type: point.type,
                                                            count: 0
                                                        };
                                                    }
                                                    sensorSummary[sensorKey].count++;
                                                });
                                            }
                                            
                                            // Log summary information
                                            const summaryText = Object.values(sensorSummary)
                                                .map(s => `${s.sensorId} (${s.type}): ${s.count} readings`)
                                                .join(', ');
                                            
                                            if (summaryText) {
                                                logSyncEvent(
                                                    `Processed history data: ${summaryText}`,
                                                    'info',
                                                    nodeId,
                                                    { requestId: payload.requestId }
                                                );
                                            }
                                        } catch (e) {
                                            logger.error('Error creating sensor summary:', e);
                                        }
                                    }
                                }
                            );
                        }
                    })
                    .catch(error => {
                        logger.error(`Error storing historical data from node ${nodeId}:`, error);
                        logSyncEvent('Error storing node data in database', 'error', nodeId, { 
                            requestId: payload.requestId, 
                            error: error.message 
                        });
                    });
            } catch (error) {
                logger.error('Error processing historical data:', error);
                logSyncEvent('Error processing historical data package', 'error', null, {
                    error: error.message,
                    topic: packet.topic
                });
            }
        }
        
        // Handle node status messages
        if (packet.topic.match(/^undergrowth\/nodes\/([^\/]+)\/status$/)) {
            try {
                const nodeId = packet.topic.split('/')[2];
                const payload = JSON.parse(packet.payload.toString());
                
                // Store node information including sensor statistics
                const nodeInfo = {
                    id: nodeId,
                    hostname: payload.hostname,
                    ip_address: payload.ip,
                    status: payload.system || {},
                    last_message: new Date().toISOString(),
                    mode: payload.mode,
                    safety: payload.safety,
                    // Store sensor statistics data
                    data: payload.data || {}
                };
                
                // Update node in the active nodes map
                activeNodes.set(nodeId, nodeInfo);
                
                // Emit node status update to all clients
                io.emit('nodeStatusUpdate', nodeInfo);
                
                // Also update node sequence info if available
                if (payload.data && payload.data.sequenceRange) {
                    const sequenceInfo = payload.data.sequenceRange;
                    
                    configDb.run(
                        'INSERT OR REPLACE INTO node_sequence_info (node_id, max_sequence, updated_at) VALUES (?, ?, ?)',
                        [nodeId, sequenceInfo.maxSequence, new Date().toISOString()],
                        (err) => {
                            if (err) {
                                logger.error(`Error updating sequence info for node ${nodeId}:`, err);
                            } else {
                                logger.info(`Updated sequence info for node ${nodeId}. Max sequence: ${sequenceInfo.maxSequence}`);
                            }
                        }
                    );
                }
                
                logger.info(`Received status update from node ${nodeId}`);
            } catch (err) {
                logger.error('Error processing node status:', err);
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

// Serve server-index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'server-index.html'));
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
  
  nodeDataDb.all(query, params, (err, rows) => {
    if (err) {
      logger.error('Error fetching sensor data:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.json(rows);
  });
});

// Get sensor data summary for a node or all nodes
app.get('/api/sensor-data/summary', (req, res) => {
  const { node_id } = req.query;
  let query = `
    SELECT 
      node_id,
      sensor_id,
      sensor_type,
      reading_type,
      MAX(timestamp) as latest_timestamp,
      (SELECT value FROM sensor_data sd2 
       WHERE sd2.node_id = sensor_data.node_id 
       AND sd2.sensor_id = sensor_data.sensor_id 
       AND sd2.reading_type = sensor_data.reading_type 
       ORDER BY timestamp DESC LIMIT 1) as latest_value,
      COUNT(*) as record_count
    FROM sensor_data
  `;
  
  const params = [];
  
  // Filter by node_id if provided
  if (node_id) {
    query += ' WHERE node_id = ?';
    params.push(node_id);
  }
  
  // Group by all relevant fields
  query += ' GROUP BY node_id, sensor_id, sensor_type, reading_type';
  
  // Order by node first, then by sensor type
  query += ' ORDER BY node_id, sensor_type, reading_type';
  
  nodeDataDb.all(query, params, (err, rows) => {
    if (err) {
      logger.error('Error fetching sensor data summary:', err);
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
  
  nodeDataDb.all(query, params, (err, rows) => {
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
    
    // Create an array of empty bins
    const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
    
    // Distribute data points into bins
    for (const row of rows) {
      const rowTime = new Date(row.timestamp).getTime();
      const offset = rowTime - startDateTime;
      const index = Math.floor(offset / timePerBin);
      if (index >= 0 && index < binCount) {
        bins[index].sum += row.value;
        bins[index].count += 1;
      }
    }
    
    // Create the result including ALL bins (even empty ones with null values)
    const binnedData = bins.map((bin, i) => {
      const binStartTime = startDateTime + (i * timePerBin);
      return {
        timestamp: new Date(binStartTime + (timePerBin / 2)).toISOString(),
        value: bin.count === 0 ? null : (bin.sum / bin.count)
      };
    });
    
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
      nodeDataDb.get(
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

// API endpoint to get all sensors in the system
app.get('/api/sensors', (req, res) => {
  // Query that gets unique sensors with their latest readings
  const query = `
    SELECT 
      node_id, 
      sensor_id, 
      sensor_type, 
      reading_type,
      COUNT(*) as reading_count,
      MAX(timestamp) as last_reading_time
    FROM sensor_data
    GROUP BY node_id, sensor_id, sensor_type, reading_type
    ORDER BY node_id, sensor_id, reading_type
  `;
  
  nodeDataDb.all(query, [], (err, rows) => {
    if (err) {
      logger.error('Error fetching sensors:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Group by node and sensor for a more organized response
    const sensorsByNode = {};
    rows.forEach(row => {
      const nodeId = row.node_id;
      const sensorId = row.sensor_id;
      
      if (!sensorsByNode[nodeId]) {
        sensorsByNode[nodeId] = {};
      }
      
      if (!sensorsByNode[nodeId][sensorId]) {
        sensorsByNode[nodeId][sensorId] = {
          id: sensorId,
          type: row.sensor_type,
          readings: {}
        };
      }
      
      // Add reading type info
      sensorsByNode[nodeId][sensorId].readings[row.reading_type] = {
        count: row.reading_count,
        lastReading: row.last_reading_time
      };
    });
    
    res.json(sensorsByNode);
  });
});

// Clean up stale pending requests
function cleanupStalePendingRequests() {
  logger.info('Cleaning up stale pending requests');
  logSyncEvent('Cleaning up stale pending requests', 'info');
  
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  
  configDb.run(
    'UPDATE history_requests SET status = ? WHERE status = ? AND request_time < ?',
    ['timeout', 'pending', oneDayAgo.toISOString()],
    function(err) {
      if (err) {
        logger.error('Error cleaning up stale pending requests:', err);
        logSyncEvent('Error cleaning up stale pending requests', 'error');
      } else {
        logger.info(`Cleaned up ${this.changes} stale pending requests`);
        logSyncEvent(`Cleaned up ${this.changes} stale pending requests`, 'info');
      }
    }
  );
  
  // Also clean out very old requests (30+ days) regardless of status
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  configDb.run(
    'DELETE FROM history_requests WHERE request_time < ?',
    [thirtyDaysAgo.toISOString()],
    function(err) {
      if (err) {
        logger.error('Error removing old request history:', err);
      } else if (this.changes > 0) {
        logger.info(`Removed ${this.changes} old history request records`);
        logSyncEvent(`Removed ${this.changes} old history request records`, 'info');
      }
    }
  );
}

// Function to check and update database schema if needed
function updateDatabaseSchema() {
  logger.info('Checking database schema for updates');
  
  // Check if history_requests table has start_sequence column
  configDb.all("PRAGMA table_info(history_requests)", [], (err, rows) => {
    if (err) {
      logger.error('Error checking history_requests table schema:', err);
      return;
    }
    
    // Check for required columns
    const hasStartSequence = rows.some(col => col && col.name === 'start_sequence');
    const hasEndSequence = rows.some(col => col && col.name === 'end_sequence');
    
    if (!hasStartSequence) {
      logger.info('Adding start_sequence column to history_requests table');
      configDb.run('ALTER TABLE history_requests ADD COLUMN start_sequence INTEGER', (err) => {
        if (err) {
          logger.error('Error adding start_sequence column:', err);
        } else {
          logger.info('Added start_sequence column to history_requests table');
        }
      });
    }
    
    if (!hasEndSequence) {
      logger.info('Adding end_sequence column to history_requests table');
      configDb.run('ALTER TABLE history_requests ADD COLUMN end_sequence INTEGER', (err) => {
        if (err) {
          logger.error('Error adding end_sequence column:', err);
        } else {
          logger.info('Added end_sequence column to history_requests table');
        }
      });
    }
  });
}

// Setup error handlers for MQTT server
mqttServer.on('error', (err) => {
  logger.error('MQTT server error:', err);
  logSyncEvent(`MQTT server error: ${err.message}`, 'error');
  // Don't exit the process, just log the error
});

// Start servers
mqttServer.listen(mqttPort, function () {
  logger.info(`MQTT server listening on port ${mqttPort}`);
  
  // Clean up stale pending requests before starting
  cleanupStalePendingRequests();
  
  // Update database schema if needed
  updateDatabaseSchema();
  
  // Check and update node data database schema
  nodeDataDb.all("PRAGMA table_info(sensor_data)", [], (err, rows) => {
    if (err) {
      logger.error('Error checking sensor_data table schema:', err);
      return;
    }
    
    // Check if sequence_id column exists
    const hasSequenceId = rows.some(row => row.name === 'sequence_id');
    
    if (!hasSequenceId) {
      logger.info('Adding sequence_id column to sensor_data table');
      nodeDataDb.run('ALTER TABLE sensor_data ADD COLUMN sequence_id INTEGER', (err) => {
        if (err) {
          logger.error('Error adding sequence_id column to sensor_data:', err);
        } else {
          logger.info('Added sequence_id column to sensor_data table');
        }
      });
    }
    
    // Check if sensor_type column exists
    const hasSensorType = rows.some(row => row.name === 'sensor_type');
    
    if (!hasSensorType) {
      logger.info('Adding sensor_type column to sensor_data table');
      nodeDataDb.run('ALTER TABLE sensor_data ADD COLUMN sensor_type TEXT', (err) => {
        if (err) {
          logger.error('Error adding sensor_type column to sensor_data:', err);
        } else {
          logger.info('Added sensor_type column to sensor_data table');
        }
      });
    }
    
    // Check if reading_type column exists (some code refers to this instead of 'type')
    const hasReadingType = rows.some(row => row.name === 'reading_type');
    
    if (!hasReadingType) {
      logger.info('Adding reading_type column to sensor_data table');
      nodeDataDb.run('ALTER TABLE sensor_data ADD COLUMN reading_type TEXT', (err) => {
        if (err) {
          logger.error('Error adding reading_type column to sensor_data:', err);
        } else {
          logger.info('Added reading_type column to sensor_data table');
        }
      });
    }
  });
  
  // Add a new periodic cleanup task
  setInterval(cleanupStalePendingRequests, 24 * 60 * 60 * 1000); // Run once a day
  
  // Log server start to UI
  logSyncEvent(`MQTT server listening on port ${mqttPort}`, 'info');
  
  // Advertise MQTT broker via mDNS
  advertiseMqttService();
  
  // Start the sync scheduler
  startSyncScheduler();
});

// Start HTTP server
httpServer.listen(port, () => {
  logger.info(`HTTP server running at http://localhost:${port}`);
});

// Reset all pending requests
app.post('/api/reset-pending-requests', (req, res) => {
  configDb.run(
    'UPDATE history_requests SET status = ? WHERE status = ?',
    ['cancelled', 'pending'],
    function(err) {
      if (err) {
        logger.error('Error resetting pending requests:', err);
        logSyncEvent('Error resetting pending requests', 'error');
        return res.status(500).json({ error: 'Database error' });
      }
      
      logger.info(`Reset ${this.changes} pending requests`);
      logSyncEvent(`Reset ${this.changes} pending requests`, 'info');
      
      res.json({ 
        success: true, 
        message: `Reset ${this.changes} pending requests` 
      });
    }
  );
});

// Get detailed sync status
app.get('/api/sync-details', (req, res) => {
  // Get pending requests count
  configDb.get('SELECT COUNT(*) as pendingCount FROM history_requests WHERE status = ?', ['pending'], (err, pendingRow) => {
    if (err) {
      logger.error('Error fetching pending count:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Get connected nodes count
    configDb.get('SELECT COUNT(*) as connectedCount FROM connected_nodes', (err, connectedRow) => {
      if (err) {
        logger.error('Error fetching connected count:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      // Get recent history requests
      configDb.all(`
        SELECT hr.*, cn.hostname 
        FROM history_requests hr
        LEFT JOIN connected_nodes cn ON hr.node_id = cn.id
        ORDER BY hr.request_time DESC LIMIT 20
      `, (err, recentRequests) => {
        if (err) {
          logger.error('Error fetching recent requests:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        // Get current sync interval and batch size
        getSyncInterval((interval) => {
          getSyncBatchSize((batchSize) => {
            res.json({
              pendingCount: pendingRow ? pendingRow.pendingCount : 0,
              connectedCount: connectedRow ? connectedRow.connectedCount : 0,
              syncInterval: interval,
              batchSize: batchSize,
              recentRequests: recentRequests || []
            });
          });
        });
      });
    });
  });
});

// Get node statistics for UI
app.get('/api/node-stats/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  
  try {
    // Get sequence information for this node from sensor_data
    nodeDataDb.get(`
      SELECT 
        MIN(timestamp) as first_timestamp,
        MAX(timestamp) as last_timestamp,
        COUNT(*) as total_records
      FROM sensor_data 
      WHERE node_id = ?
    `, [nodeId], (err, dbStats) => {
      if (err) {
        logger.error(`Error fetching database stats for node ${nodeId}:`, err);
        return res.status(500).json({ error: 'Database error', message: err.message });
      }
      
      // If we don't have any records, return empty stats
      if (!dbStats || !dbStats.first_timestamp) {
        return res.json({
          first_timestamp: null,
          last_timestamp: null,
          total_records: 0,
          last_sequence: 0,
          max_sequence: 0
        });
      }
      
      // Get the latest sequence from node_sequence_info rather than node_sync_status
      configDb.get(`
        SELECT last_sequence, max_sequence 
        FROM node_sequence_info 
        WHERE node_id = ?
      `, [nodeId], (err, seqInfo) => {
        if (err) {
          logger.error(`Error fetching sequence info for node ${nodeId}:`, err);
          // Continue with partial data instead of returning an error
          res.json({
            ...dbStats,
            last_sequence: 0,
            max_sequence: 0
          });
        } else {
          // Combine the data
          res.json({
            ...dbStats,
            last_sequence: seqInfo?.last_sequence || 0,
            max_sequence: seqInfo?.max_sequence || 0
          });
        }
      });
    });
  } catch (error) {
    logger.error(`Unexpected error in node-stats endpoint for ${nodeId}:`, error);
    res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// Get node MQTT status
app.get('/api/node-mqtt-status/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  
  if (!nodeId) {
    return res.status(400).json({ error: 'Node ID is required' });
  }
  
  // Get node from connected_nodes
  configDb.get('SELECT * FROM connected_nodes WHERE id = ?', [nodeId], (err, node) => {
    if (err) {
      logger.error('Error fetching node MQTT status:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    
    // Get subscription info 
    const subscriptions = [
      `undergrowth/nodes/${nodeId}/#`, // Node data topics
      `undergrowth/server/requests/${nodeId}/#` // Server request topics
    ];
    
    // Gather topic stats - count of messages by topic from the logs
    logsDb.all(
      `SELECT context FROM logs 
       WHERE node_id = ? AND level = 'info' AND message LIKE '%Data request published to node%'
       ORDER BY timestamp DESC LIMIT 20`,
      [nodeId],
      (err, pubLogs) => {
        if (err) {
          logger.error('Error fetching node publication logs:', err);
          return res.status(500).json({ error: 'Database error' });
        }
        
        // Parse topics from context
        const topics = [];
        if (pubLogs && pubLogs.length > 0) {
          pubLogs.forEach(log => {
            try {
              // Extract topic from context if possible
              if (log.context) {
                const ctx = typeof log.context === 'string' ? JSON.parse(log.context) : log.context;
                if (ctx && ctx.topic) {
                  if (!topics.includes(ctx.topic)) {
                    topics.push(ctx.topic);
                  }
                }
              }
            } catch (e) {
              // Ignore parsing errors
            }
          });
        }
        
        res.json({
          node_id: nodeId,
          connected: !!node,
          last_seen: node ? node.last_message : null,
          hostname: node ? node.hostname : null,
          ip_address: node ? node.ip_address : null,
          connected_since: node ? node.connected_since : null,
          subscriptions: subscriptions,
          recent_topics: topics
        });
      }
    );
  });
});

// Update sync batch size
app.post('/api/sync-batch-size', express.json(), (req, res) => {
  const { batchSize } = req.body;
  
  if (!batchSize) {
    return res.status(400).json({ error: 'Batch size is required' });
  }
  
  updateSyncBatchSize(batchSize, (err, newBatchSize) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    
    // Restart sync scheduler to apply new batch size
    startSyncScheduler();
    
    res.json({ success: true, batchSize: newBatchSize });
  });
});

// Function to get data for a specific sequence range
app.get('/api/node-data/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const { startSequence, endSequence, limit } = req.query;
  
  // Input validation
  const parsedStartSeq = parseInt(startSequence || '0');
  const parsedEndSeq = parseInt(endSequence || '999999999');
  const parsedLimit = parseInt(limit || '1000');
  
  if (isNaN(parsedStartSeq) || isNaN(parsedEndSeq) || isNaN(parsedLimit)) {
    return res.status(400).json({ error: 'Invalid sequence or limit parameters' });
  }
  
  // Query the database
  nodeDataDb.all(
    `SELECT id, timestamp, node_id, sensor_id, sensor_type, reading_type, value, sequence_id 
     FROM sensor_data 
     WHERE node_id = ? AND sequence_id >= ? AND sequence_id <= ? 
     ORDER BY sequence_id ASC
     LIMIT ?`,
    [nodeId, parsedStartSeq, parsedEndSeq, parsedLimit],
    (err, rows) => {
      if (err) {
        logger.error('Error querying node data:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      
      res.json(rows);
    }
  );
});

// For each connected node, get their pending request count
function cleanupExcessPendingRequests() {
  logger.info('Checking for excess pending requests');

  // Get all nodes with pending requests
  configDb.all(
    `SELECT node_id, COUNT(*) as pending_count 
     FROM history_requests 
     WHERE status = 'pending' 
     GROUP BY node_id 
     HAVING COUNT(*) > 1`,
    (err, rows) => {
      if (err) {
        logger.error('Error checking for excess pending requests:', err);
        return;
      }

      if (!rows || rows.length === 0) {
        return;
      }

      // For each node with more than 1 pending request, delete all but the most recent
      rows.forEach(row => {
        logger.warn(`Node ${row.node_id} has ${row.pending_count} pending requests, cleaning up`);
        
        // Keep only the most recent pending request
        configDb.run(
          `DELETE FROM history_requests 
           WHERE status = 'pending' 
           AND node_id = ? 
           AND request_id NOT IN (
             SELECT request_id 
             FROM history_requests 
             WHERE status = 'pending' 
             AND node_id = ? 
             ORDER BY created_at DESC 
             LIMIT 1
           )`,
          [row.node_id, row.node_id],
          (err) => {
            if (err) {
              logger.error(`Error cleaning up excess pending requests for node ${row.node_id}:`, err);
            } else {
              logger.info(`Cleaned up excess pending requests for node ${row.node_id}`);
              logSyncEvent(
                `Cleaned up stale pending requests`, 
                'info', 
                row.node_id, 
                { pendingCount: row.pending_count }
              );
            }
          }
        );
      });
    }
  );
}