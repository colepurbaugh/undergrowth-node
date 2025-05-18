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
    app.put('/api/sensors/:id', (req, res) => {
        const { id } = req.params;
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
        params.push(id);

        const query = `UPDATE sensor_config SET ${updateFields.join(', ')} WHERE id = ?`;

        configDb.run(query, params, function (err) {
            if (err) {
                console.error('API: Error updating sensor:', err);
                return res.status(500).json({ error: 'Failed to update sensor' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: 'Sensor not found' });
            }

            configDb.get('SELECT * FROM sensor_config WHERE id = ?', [id], (err, row) => {
                if (err) {
                    console.error('API: Error fetching updated sensor:', err);
                    return res.status(500).json({ error: 'Failed to fetch updated sensor' });
                }
                res.json(row);
            });
        });
    });

    // API Endpoint to delete a sensor
    app.delete('/api/sensors/:id', (req, res) => {
        const { id } = req.params;

        configDb.run('DELETE FROM sensor_config WHERE id = ?', [id], function (err) {
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
                SELECT timestamp, device_id, value
                FROM sensor_readings
                WHERE type = ? AND timestamp >= ? AND timestamp < ?
            `;
            const params = [type, startIso, endIso];

            if (sensorsQuery && sensorsQuery.length > 0) {
                const deviceIdMatches = [];
                sensorsQuery.forEach(id => {
                    if (id === 'legacy1') deviceIdMatches.push('sensor1');
                    else if (id === 'legacy2') deviceIdMatches.push('sensor2');
                    else deviceIdMatches.push(`sensor_${id}`);
                });
                if (deviceIdMatches.length > 0) {
                    sql += ` AND device_id IN (${deviceIdMatches.map(() => '?').join(',')})`;
                    params.push(...deviceIdMatches);
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
                    if (!sensorData[row.device_id]) sensorData[row.device_id] = [];
                    sensorData[row.device_id].push(row);
                });
                console.log(`API: Grouped binned data into ${Object.keys(sensorData).length} sensors`);
                const result = [];
                Object.entries(sensorData).forEach(([sensorId, sensorRows]) => {
                    const bins = new Array(binCount).fill(null).map(() => ({ sum: 0, count: 0 }));
                    const totalMs = endMs - startMs;
                    const binSizeMs = totalMs / binCount;
                    for (const row of sensorRows) {
                        const tMs = Date.parse(row.timestamp);
                        const offset = tMs - startMs;
                        const index = Math.floor(offset / binSizeMs);
                        if (index >= 0 && index < binCount) {
                            bins[index].sum += row.value;
                            bins[index].count += 1;
                        }
                    }
                    bins.forEach((b, i) => {
                        if (b.count > 0) {
                            result.push({
                                timestamp: new Date(startMs + (i * binSizeMs)).toISOString(),
                                sensorId: sensorId,
                                value: b.sum / b.count
                            });
                        }
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
    app.get('/api/sensor-stats/:sensorId', async (req, res) => {
        try {
            const sensorIdParam = req.params.sensorId; // Renamed to avoid conflict

            const sensor = await new Promise((resolve, reject) => {
                configDb.get('SELECT * FROM sensor_config WHERE id = ?', [sensorIdParam],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            if (!sensor) {
                return res.status(404).json({ error: 'Sensor not found' });
            }

            const deviceId = `sensor_${sensorIdParam}`;

            const recordCount = await new Promise((resolve, reject) => {
                dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ?', [deviceId],
                    (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
            });

            const firstRecord = await new Promise((resolve, reject) => {
                dataDb.get('SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp ASC LIMIT 1', [deviceId],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            const lastRecord = await new Promise((resolve, reject) => {
                dataDb.get('SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1', [deviceId],
                    (err, row) => err ? reject(err) : resolve(row));
            });

            res.json({
                sensorId: sensorIdParam,
                address: sensor.address,
                type: sensor.type,
                recordCount,
                firstTimestamp: firstRecord ? firstRecord.timestamp : null,
                lastTimestamp: lastRecord ? lastRecord.timestamp : null
            });
        } catch (error) {
            console.error(`API: Error getting sensor stats for sensor ${req.params.sensorId}:`, error);
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

            const allSensors = [
                ...configuredSensors,
                { id: 'legacy1', address: '0x38', type: 'AHT10', name: 'Legacy AHT10 (0x38)', deviceId: 'sensor1' },
                { id: 'legacy2', address: '0x39', type: 'AHT10', name: 'Legacy AHT10 (0x39)', deviceId: 'sensor2' }
            ];

            console.log(`API: Processing statistics for ${allSensors.length} sensors in summary`);

            const sensorStats = [];
            let totalRecordCount = 0;

            for (const sensor of allSensors) {
                let deviceId = sensor.deviceId; // Use pre-defined if available (for legacy)
                if (!deviceId) { // Construct for configured sensors
                    deviceId = `sensor_${sensor.id}`;
                }

                // console.log(`API: Fetching summary stats for sensor ${sensor.id} (${sensor.address}) using deviceId: ${deviceId}`);

                const tempCount = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
                        [deviceId, 'temperature'], (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
                });

                const humidityCount = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT COUNT(*) as count FROM sensor_readings WHERE device_id = ? AND type = ?',
                        [deviceId, 'humidity'], (err, row) => err ? reject(err) : resolve(row ? row.count : 0));
                });

                const firstRecord = await new Promise((resolve, reject) => {
                    dataDb.get('SELECT timestamp FROM sensor_readings WHERE device_id = ? ORDER BY timestamp ASC LIMIT 1',
                        [deviceId], (err, row) => err ? reject(err) : resolve(row));
                });

                const sensorTotal = tempCount + humidityCount;
                totalRecordCount += sensorTotal;

                sensorStats.push({
                    id: sensor.id,
                    deviceId: deviceId,
                    name: sensor.name || `${sensor.type} @ ${sensor.address}`,
                    address: sensor.address,
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

    console.log('API Controller: API routes initialized.');
};