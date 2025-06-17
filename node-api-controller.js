// api-controller.js

// Helper functions (can be kept here or passed if shared more broadly)
// For now, let's assume they are primarily used by these API endpoints or can be redefined here using db access.

async function getSequenceRange(dataDb) {
    return new Promise((resolve, reject) => {
        dataDb.get('SELECT MIN(sequence_id) as min_seq, MAX(sequence_id) as max_seq, COUNT(*) as count FROM sensor_readings', [], (err, row) => {
            if (err) {
                console.error('API Controller: Error getting sequence range:', err);
                reject(err);
                return;
            }
            resolve({
                minSequence: row.min_seq || 0,
                maxSequence: row.max_seq || 0,
                count: row.count || 0
            });
        });
    });
}

module.exports = function (app, configDb, dataDb) {
    console.log('API Controller: Initializing API routes...');

    // API Endpoint to get sensor configurations
    app.get('/api/sensors', (req, res) => {
        configDb.all('SELECT * FROM sensor_config ORDER BY created_at ASC', [], (err, rows) => {
            if (err) {
                console.error('API: Error fetching sensors:', err);
                return res.status(500).json({ error: 'Failed to fetch sensors' });
            }
            res.json(rows);
        });
    });

    // API Endpoint to add a new sensor
    app.post('/api/sensors', (req, res) => {
        const { address, type, name } = req.body;

        if (!address || !type) {
            return res.status(400).json({ error: 'Address and type are required' });
        }

        configDb.run(
            'INSERT INTO sensor_config (address, type, name) VALUES (?, ?, ?)',
            [address, type, name || null],
            function (err) {
                if (err) {
                    console.error('API: Error adding sensor:', err);
                    return res.status(500).json({ error: 'Failed to add sensor' });
                }

                const id = this.lastID;
                res.status(201).json({
                    id,
                    address,
                    type,
                    name,
                    enabled: 1, // Default value from schema
                    calibration_offset: 0.0, // Default value from schema
                    calibration_scale: 1.0 // Default value from schema
                });
            }
        );
    });

    // API Endpoint to update a sensor
    app.put('/api/sensors/:address', (req, res) => {
        const { address } = req.params;
        const { name, enabled, calibration_offset, calibration_scale } = req.body;

        const updateFields = [];
        const params = [];

        if (name !== undefined) {
            updateFields.push('name = ?');
            params.push(name);
        }
        if (enabled !== undefined) {
            updateFields.push('enabled = ?');
            params.push(enabled ? 1 : 0);
        }
        if (calibration_offset !== undefined) {
            updateFields.push('calibration_offset = ?');
            params.push(calibration_offset);
        }
        if (calibration_scale !== undefined) {
            updateFields.push('calibration_scale = ?');
            params.push(calibration_scale);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updateFields.push('last_updated = CURRENT_TIMESTAMP');
        params.push(address);

        const query = `UPDATE sensor_config SET ${updateFields.join(', ')} WHERE address = ?`;

        configDb.run(query, params, function (err) {
            if (err) {
                console.error('API: Error updating sensor:', err);
                return res.status(500).json({ error: 'Failed to update sensor' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Sensor not found' });
            }

            configDb.get('SELECT * FROM sensor_config WHERE address = ?', [address], (err, row) => {
                if (err) {
                    console.error('API: Error fetching updated sensor:', err);
                    return res.status(500).json({ error: 'Failed to fetch updated sensor' });
                }
                res.json(row);
            });
        });
    });

    // API Endpoint to delete a sensor
    app.delete('/api/sensors/:address', (req, res) => {
        const { address } = req.params;

        configDb.run('DELETE FROM sensor_config WHERE address = ?', [address], function (err) {
            if (err) {
                console.error('API: Error deleting sensor:', err);
                return res.status(500).json({ error: 'Failed to delete sensor' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Sensor not found' });
            }

            res.status(204).send();
        });
    });

    // Binned Readings Endpoint
    app.get('/api/readings/binned', async (req, res) => {
        try {
            const startDateParam = req.query.startDate;
            const hours = parseInt(req.query.hours, 10);
            const binCount = parseInt(req.query.points, 10);
            const type = req.query.type;
            const sensorsQuery = req.query.sensors ? req.query.sensors.split(',') : null;
            const showAverage = req.query.average === 'true';

            console.log(`API: Binned readings request: type=${type}, sensors=${req.query.sensors}, average=${showAverage}`);

            if (!startDateParam || isNaN(hours) || isNaN(binCount) || !type) {
                return res.status(400).json({
                    error: 'Missing or invalid startDate, hours, points, or type'
                });
            }

            const startMs = Date.parse(startDateParam);
            if (isNaN(startMs)) {
                return res.status(400).json({ error: 'Invalid startDate format' });
            }
            const endMs = startMs + (hours * 3600 * 1000);

            const startIso = new Date(startMs).toISOString();
            const endIso = new Date(endMs).toISOString();

            console.log(`API: Date range for binned readings: ${startIso} to ${endIso}`);

            let sql = `
                SELECT timestamp, address, value
                FROM sensor_readings
                WHERE type = ? AND timestamp >= ? AND timestamp < ?
            `;
            const params = [type, startIso, endIso];

            if (sensorsQuery && sensorsQuery.length > 0) {
                const addressMatches = [];
                sensorsQuery.forEach(id => {
                    const baseAddress = id.split('-')[0]; 
                    if (id === 'legacy1' || id === '1') addressMatches.push('0x38');
                    else if (id === 'legacy2' || id === '2') addressMatches.push('0x39');
                    else if (baseAddress.startsWith('0x')) addressMatches.push(baseAddress);
                    else addressMatches.push(id);
                });
                if (addressMatches.length > 0) {
                    sql += ` AND address IN (${addressMatches.map(() => '?').join(',')})`;
                    params.push(...addressMatches);
                }
            }
            sql += ' ORDER BY timestamp ASC';

            console.log('API: Binned SQL Query:', sql);
            console.log('API: Binned Params:', params);

            const rawRows = await new Promise((resolve, reject) => {
                dataDb.all(sql, params, (err, rows) => {
                    if (err) return reject(err);
                    console.log(`API: Retrieved ${rows.length} raw rows for binned data`);
                    resolve(rows);
                });
            });

            if (!rawRows || rawRows.length === 0) {
                console.log('API: No data found for binned readings in the specified range');
                return res.json([]);
            }

            if (showAverage) {
                const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
                const totalMs = endMs - startMs;
                const binSizeMs = totalMs / binCount;

                for (const row of rawRows) {
                    const tMs = Date.parse(row.timestamp);
                    const offset = tMs - startMs;
                    const index = Math.floor(offset / binSizeMs);
                    if (index >= 0 && index < binCount) {
                        bins[index].sum += row.value;
                        bins[index].count += 1;
                    }
                }
                const result = bins.map((b, i) => ({
                    timestamp: new Date(startMs + (i * binSizeMs)).toISOString(),
                    value: (b.count === 0) ? null : (b.sum / b.count)
                }));
                console.log(`API: Returning ${result.length} averaged binned data points`);
                res.json(result);
            } else {
                const sensorData = {};
                rawRows.forEach(row => {
                    if (!sensorData[row.address]) sensorData[row.address] = [];
                    sensorData[row.address].push(row);
                });
                console.log(`API: Grouped binned data into ${Object.keys(sensorData).length} sensors`);
                const result = [];
                Object.entries(sensorData).forEach(([address, sensorRows]) => {
                    const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0, isGap: false }));
                    const totalMs = endMs - startMs;
                    const binSizeMs = totalMs / binCount;
                    
                    // Track last timestamp for gap detection
                    let lastTimestamp = null;
                    const gapThresholdMs = 10 * 60 * 1000; // 10 minutes in milliseconds
                    
                    for (const row of sensorRows) {
                        const tMs = Date.parse(row.timestamp);
                        const offset = tMs - startMs;
                        const index = Math.floor(offset / binSizeMs);
                        
                        // Check for gaps
                        if (lastTimestamp) {
                            const gapMs = tMs - lastTimestamp;
                            if (gapMs > gapThresholdMs) {
                                // Insert null points in bins between the gap
                                const lastIndex = Math.floor((lastTimestamp - startMs) / binSizeMs);
                                const currentIndex = index;
                                for (let i = lastIndex + 1; i < currentIndex; i++) {
                                    if (i >= 0 && i < binCount) {
                                        bins[i].isGap = true;
                                    }
                                }
                            }
                        }
                        if (index >= 0 && index < binCount) {
                            bins[index].sum += row.value;
                            bins[index].count += 1;
                        }
                        lastTimestamp = tMs;
                    }
                    // Always output a value for every bin
                    bins.forEach((b, i) => {
                        result.push({
                            timestamp: new Date(startMs + (i * binSizeMs)).toISOString(),
                            sensorId: address,
                            value: (b.count > 0) ? (b.sum / b.count) : null
                        });
                    });
                });
                console.log(`API: Returning ${result.length} binned data points across all sensors`);
                res.json(result);
            }
        } catch (error) {
            console.error('API: Error in binned readings:', error);
            res.status(500).json({ error: 'Failed to fetch binned readings' });
        }
    });

    // API endpoint for sequence information
    app.get('/api/sequence-info', async (req, res) => {
        try {
            const sequenceRangeData = await getSequenceRange(dataDb); // Use helper

            let firstTimestamp = null;
            let lastTimestamp = null;

            if (sequenceRangeData.minSequence > 0) {
                const firstRecord = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                        [sequenceRangeData.minSequence], (err, row) => err ? reject(err) : resolve(row));
                });
                if (firstRecord) firstTimestamp = firstRecord.timestamp;
            }

            if (sequenceRangeData.maxSequence > 0) {
                const lastRecord = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                        [sequenceRangeData.maxSequence], (err, row) => err ? reject(err) : resolve(row));
                });
                if (lastRecord) lastTimestamp = lastRecord.timestamp;
            }

            const serverSync = await new Promise((resolve, reject) => {
                configDb.get('SELECT * FROM server_sync ORDER BY last_seen DESC LIMIT 1', [],
                    (err, row) => err ? reject(err) : resolve(row || null));
            });

            let serverSyncDetails = null;
            if (serverSync) {
                let syncGap = 0;
                if (sequenceRangeData.maxSequence > 0) {
                    syncGap = sequenceRangeData.maxSequence - (serverSync.last_sequence || 0);
                }

                let lastSyncedTimestamp = null;
                if (serverSync.last_sequence > 0) {
                    const syncedRecord = await new Promise((resolve, reject) => {
                        dataDb.get('SELECT timestamp FROM sensor_readings WHERE sequence_id = ? LIMIT 1',
                            [serverSync.last_sequence], (err, row) => err ? reject(err) : resolve(row));
                    });
                    if (syncedRecord) lastSyncedTimestamp = syncedRecord.timestamp;
                }

                const sentCount = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE sequence_id <= ?',
                        [serverSync.last_sequence || 0], (err, row) => err ? reject(err) : resolve(row.count || 0));
                });
                serverSyncDetails = { ...serverSync, sentCount, lastSyncedTimestamp, syncGap };
            }

            res.json({
                nodeSequence: { ...sequenceRangeData, firstTimestamp, lastTimestamp },
                serverSync: serverSyncDetails
            });

        } catch (error) {
            console.error('API: Error getting sequence info:', error);
            res.status(500).json({ error: 'Failed to get sequence information' });
        }
    });

    // API endpoint for individual sensor statistics
    app.get('/api/sensor-stats/:address', async (req, res) => {
        try {
            const addressParam = req.params.address;

            const sensor = await new Promise((resolve, reject) => {
                configDb.get('SELECT * FROM sensor_config WHERE address = ?', [addressParam],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            if (!sensor) {
                return res.status(404).json({ error: 'Sensor not found' });
            }

            const recordCount = await new Promise((resolve, reject) => {
                dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE address = ?', [addressParam],
                    (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
            });

            const firstRecord = await new Promise((resolve, reject) => {
                dataDb.get('SELECT timestamp FROM sensor_readings WHERE address = ? ORDER BY timestamp ASC LIMIT 1', [addressParam],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            const lastRecord = await new Promise((resolve, reject) => {
                dataDb.get('SELECT timestamp FROM sensor_readings WHERE address = ? ORDER BY timestamp DESC LIMIT 1', [addressParam],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            res.json({
                address: addressParam,
                type: sensor.type,
                name: sensor.name,
                recordCount,
                firstTimestamp: firstRecord ? firstRecord.timestamp : null,
                lastTimestamp: lastRecord ? lastRecord.timestamp : null
            });
        } catch (error) {
            console.error(`API: Error getting sensor stats for sensor ${req.params.address}:`, error);
            res.status(500).json({ error: 'Failed to get sensor statistics' });
        }
    });

    // API endpoint for sensor statistics summary
    app.get('/api/sensor-stats/summary', async (req, res) => {
        try {
            const configuredSensors = await new Promise((resolve, reject) => {
                configDb.all('SELECT * FROM sensor_config', [],
                    (err, rows) => err ? reject(err) : resolve(rows || []));
            });

            console.log(`API: Processing statistics for ${configuredSensors.length} sensors in summary`);

            const sensorStats = [];
            let totalRecordCount = 0;

            for (const sensor of configuredSensors) {
                const address = sensor.address;

                // console.log(`API: Fetching summary stats for sensor ${sensor.address} using address: ${address}`);

                const tempCount = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE address = ? AND type = ?',
                        [address, 'temperature'], (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
                });

                const humidityCount = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE address = ? AND type = ?',
                        [address, 'humidity'], (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
                });

                const firstRecord = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT timestamp FROM sensor_readings WHERE address = ? ORDER BY timestamp ASC LIMIT 1',
                        [address], (err, row) => err ? reject(err) : resolve(row));
                });

                const sensorTotal = tempCount + humidityCount;
                totalRecordCount += sensorTotal;

                sensorStats.push({
                    address: sensor.address,
                    name: sensor.name || `${sensor.type} @ ${sensor.address}`,
                    type: sensor.type,
                    temperatureCount: tempCount,
                    humidityCount: humidityCount,
                    totalCount: sensorTotal,
                    firstTimestamp: firstRecord ? firstRecord.timestamp : null
                });
            }

            res.json({
                sensors: sensorStats,
                totalRecordCount,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('API: Error getting sensor statistics summary:', error);
            res.status(500).json({ error: 'Failed to get sensor statistics summary' });
        }
    });

    // API Endpoint to get event triggers for graph markers
    app.get('/api/event-triggers', (req, res) => {
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' });
        }
        
        // Convert UTC timestamps to local time format for database query
        // The database stores timestamps in local time (YYYY-MM-DD HH:MM:SS)
        // but the frontend sends UTC timestamps (YYYY-MM-DDTHH:MM:SS.sssZ)
        const startLocal = new Date(startDate).toISOString().slice(0, 19).replace('T', ' ');
        const endLocal = new Date(endDate).toISOString().slice(0, 19).replace('T', ' ');
        
        console.log(`API: Event triggers query - UTC range: ${startDate} to ${endDate}`);
        console.log(`API: Event triggers query - Local range: ${startLocal} to ${endLocal}`);
        
        // Get event triggers from the event_log table (actual triggers)
        configDb.all(
            `SELECT el.*, e.sensor_address, e.sensor_type, e.threshold_value, e.threshold_condition 
             FROM event_log el 
             LEFT JOIN events e ON el.event_id = e.id 
             WHERE el.timestamp >= ? AND el.timestamp <= ? AND el.action = 'triggered' 
             ORDER BY el.timestamp ASC`,
            [startLocal, endLocal],
            (err, rows) => {
                if (err) {
                    console.error('API: Error fetching event triggers:', err);
                    return res.status(500).json({ error: 'Failed to fetch event triggers' });
                }
                
                // Transform the data for the frontend
                const triggers = rows.map(row => ({
                    id: row.id,
                    timestamp: row.timestamp,
                    gpio: row.gpio,
                    pwm_value: row.pwm_value,
                    trigger_type: row.trigger_source || 'threshold',

                    sensor_address: row.sensor_address,
                    sensor_type: row.sensor_type,
                    threshold_value: row.threshold_value,
                    threshold_condition: row.threshold_condition,
                    notes: row.notes
                }));
                
                console.log(`API: Returning ${triggers.length} event triggers for date range ${startDate} to ${endDate}`);
                res.json(triggers);
            }
        );
    });
    
    // API Endpoint to get configured events for graph markers
    app.get('/api/configured-events', (req, res) => {
        // Get all configured events from the database
        configDb.all(
            'SELECT * FROM events ORDER BY id ASC',
            [],
            (err, rows) => {
                if (err) {
                    console.error('API: Error fetching configured events:', err);
                    return res.status(500).json({ error: 'Failed to fetch configured events' });
                }
                
                // Transform the data for the frontend
                const events = rows.map(row => ({
                    id: row.id,
                    gpio: row.gpio,
                    pwm_value: row.pwm_value,
                    enabled: row.enabled === 1,
                    trigger_type: row.trigger_type,
                    time: row.time,
                    sensor_address: row.sensor_address,
                    sensor_type: row.sensor_type,
                    threshold_condition: row.threshold_condition,
                    threshold_value: row.threshold_value,
                    cooldown_minutes: row.cooldown_minutes,
                    priority: row.priority,
                    last_triggered_at: row.last_triggered_at
                }));
                
                console.log(`API: Returning ${events.length} configured events`);
                res.json(events);
            }
        );
    });
    
    // API Endpoint to get error logs for graph markers  
    app.get('/api/error-logs', (req, res) => {
        const startDate = req.query.startDate;
        const endDate = req.query.endDate;
        
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'startDate and endDate are required' });
        }
        
        // For now, return empty array since we don't have error logging table yet
        // TODO: Create error_logs table and implement error logging
        res.json([]);
    });

    // Event notes endpoints
    app.get('/api/event-notes/:id', (req, res) => {
        const eventId = req.params.id;
        
        configDb.get(`SELECT notes FROM event_log WHERE id = ?`, [eventId], (err, row) => {
            if (err) {
                console.error('Error fetching event notes:', err);
                res.status(500).json({ error: 'Failed to fetch notes' });
                return;
            }
            
            res.json({ notes: row ? row.notes : '' });
        });
    });
    
    app.post('/api/event-notes/:id', (req, res) => {
        const eventId = req.params.id;
        const { notes } = req.body;
        
        if (typeof notes !== 'string') {
            res.status(400).json({ error: 'Notes must be a string' });
            return;
        }
        
        configDb.run(`UPDATE event_log SET notes = ? WHERE id = ?`, [notes, eventId], function(err) {
            if (err) {
                console.error('Error saving event notes:', err);
                res.status(500).json({ error: 'Failed to save notes' });
                return;
            }
            
            if (this.changes === 0) {
                res.status(404).json({ error: 'Event not found' });
                return;
            }
            
            res.json({ success: true, message: 'Notes saved successfully' });
        });
    });

    console.log('API Controller: API routes initialized.');
};