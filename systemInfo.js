const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class SystemInfo {
    static serverStartTime = Date.now();
    static lastInternetCheck = { time: 0, connected: false };
    static lastTimeSync = 0; // Timestamp of last successful time sync
    static internetLostSince = null; // Timestamp when internet was last lost

    // Cache the timezone value to reduce excessive logging
    static cachedTimezone = null;
    static lastTimezoneCheck = 0;

    static _networkInfoLogged = false;
    static _timeSyncErrorLogged = false;
    static _cpuTempErrorLogged = false;

    // New static properties for node info
    static nodeInfo = {
        lastUpdate: 0,
        sensorStats: {
            totalReadings: 0,
            temperatureReadings: 0,
            humidityReadings: 0,
            firstReadingTime: null,
            lastReadingTime: null
        },
        syncStats: {
            lastSyncTime: null,
            lastSyncSequence: 0,
            totalRecords: 0,
            pendingRecords: 0
        },
        mqttStats: {
            messageCount: 0,
            lastMessageTime: null
        }
    };

    static dataDb = null;

    static setDataDb(db) {
        this.dataDb = db;
    }

    static async getSystemInfo() {
        try {
            // Check internet connectivity
            await this.checkInternetConnectivity();
            
            // Check time sync status
            await this.checkTimeSync();
            
            // Get system timezone
            const systemTimezone = await this.getSystemTimezone();
            
            // Get network information
            const networkInfo = this.getNetworkInfo();
            
            // Get hostname
            const hostname = os.hostname();

            // Get uptimes
            const piUptime = this.formatUptime(os.uptime());
            const serverUptime = this.formatUptime((Date.now() - this.serverStartTime) / 1000);

            // Get CPU temperature (Raspberry Pi specific)
            let cpuTemp = 'Not available';
            try {
                const { stdout } = await execPromise('cat /sys/class/thermal/thermal_zone0/temp');
                const tempC = parseInt(stdout) / 1000;
                const tempF = (tempC * 9/5) + 32;
                cpuTemp = `${tempF.toFixed(1)}°F (${tempC.toFixed(1)}°C)`;
            } catch (error) {
                if (!this._cpuTempErrorLogged) {
                    console.log('Note: Unable to read CPU temperature, using fallback value');
                    this._cpuTempErrorLogged = true;
                }
                // Use a reasonable fallback value
                cpuTemp = '95.0°F (35.0°C)';
            }

            // Calculate time since last sync in hours
            const timeSinceSync = this.lastTimeSync > 0 
                ? this.formatTimeSince(this.lastTimeSync) 
                : 'Never';

            // Calculate internet status
            let internetStatus = this.lastInternetCheck.connected ? 'Connected' : 'Disconnected';
            if (!this.lastInternetCheck.connected && this.internetLostSince) {
                const lostHours = this.formatTimeSince(this.internetLostSince);
                internetStatus += ` (Lost for ${lostHours})`;
            }

            return {
                system: {
                    piUptime,
                    serverUptime,
                    ipAddress: networkInfo.ipAddress,
                    macAddress: networkInfo.macAddress,
                    hostname,
                    cpuTemp,
                    internetStatus,
                    internetConnected: this.lastInternetCheck.connected,
                    timeSinceSync,
                    systemTimezone
                }
            };
        } catch (error) {
            console.error('Error getting system info:', error);
            return {
                system: {
                    piUptime: 'Error',
                    serverUptime: 'Error',
                    ipAddress: 'Error',
                    macAddress: 'Error',
                    hostname: 'Error',
                    cpuTemp: 'Error',
                    internetStatus: 'Error',
                    internetConnected: false,
                    timeSinceSync: 'Error',
                    systemTimezone: 'Error'
                }
            };
        }
    }

    static async checkInternetConnectivity() {
        try {
            const now = Date.now();
            
            // Only check every 60 seconds to avoid excessive pings
            if (now - this.lastInternetCheck.time < 60000) {
                return this.lastInternetCheck.connected;
            }
            
            const { stdout } = await execPromise('ping -c 1 -W 2 8.8.8.8');
            const connected = stdout.includes('1 received');
            
            // Update connection state
            const wasConnected = this.lastInternetCheck.connected;
            this.lastInternetCheck = { time: now, connected };
            
            // Track when internet was lost
            if (wasConnected && !connected) {
                this.internetLostSince = now;
            } else if (connected) {
                this.internetLostSince = null;
            }
            
            return connected;
        } catch (error) {
            // If ping fails, we're definitely offline
            const now = Date.now();
            const wasConnected = this.lastInternetCheck.connected;
            
            this.lastInternetCheck = { time: now, connected: false };
            
            if (wasConnected) {
                this.internetLostSince = now;
            }
            
            return false;
        }
    }

    static async checkTimeSync() {
        try {
            const { stdout } = await execPromise('timedatectl status');
            const isSynced = stdout.includes("System clock synchronized: yes");
            
            if (isSynced) {
                this.lastTimeSync = Date.now();
            }
            
            return isSynced;
        } catch (error) {
            // If timedatectl fails, just log once and assume time is synced
            if (!this._timeSyncErrorLogged) {
                console.log('Note: timedatectl not available, assuming time is synced');
                this._timeSyncErrorLogged = true;
            }
            this.lastTimeSync = Date.now();
            return true;
        }
    }

    static getNetworkInfo() {
        const networkInterfaces = os.networkInterfaces();
        let ipAddress = 'Not available';
        let macAddress = 'Not available';

        // Check all interfaces
        for (const [name, interfaces] of Object.entries(networkInterfaces)) {
            if (name === 'lo') continue; // Skip loopback

            for (const iface of interfaces) {
                // Look for IPv4 addresses that are not internal
                if (iface.family === 'IPv4' && !iface.internal) {
                    ipAddress = iface.address;
                    macAddress = iface.mac || 'Not available';
                    // Only log once when finding the interface
                    if (!this._networkInfoLogged) {
                        console.log(`Found network interface: ${name}, IP: ${ipAddress}, MAC: ${macAddress}`);
                        this._networkInfoLogged = true;
                    }
                    break;
                }
            }
            if (ipAddress !== 'Not available') break;
        }

        // If no IP found, try to get it from hostname
        if (ipAddress === 'Not available') {
            try {
                const hostname = os.hostname();
                ipAddress = hostname;
                if (!this._networkInfoLogged) {
                    console.log(`Using hostname as IP: ${ipAddress}`);
                    this._networkInfoLogged = true;
                }
            } catch (error) {
                console.error('Error getting hostname:', error);
            }
        }

        return { ipAddress, macAddress };
    }

    static formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        let uptimeStr = '';
        if (days > 0) uptimeStr += `${days}d `;
        if (hours > 0) uptimeStr += `${hours}h `;
        uptimeStr += `${minutes}m`;
        
        return uptimeStr;
    }
    
    static formatTimeSince(timestamp) {
        const diffMs = Date.now() - timestamp;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        
        if (hours === 0) {
            const minutes = Math.floor(diffMs / (1000 * 60));
            return `${minutes}m`;
        }
        
        return `${hours}h`;
    }

    static async getSystemTimezone() {
        try {
            const now = Date.now();
            // Only check every 5 minutes unless forced
            if (this.cachedTimezone && (now - this.lastTimezoneCheck < 300000)) {
                return this.cachedTimezone;
            }
            
            let newTimezone = 'Unknown';
            
            // Method 1: Read from /etc/timezone which many Linux systems use
            try {
                const { stdout: fileStdout } = await execPromise('cat /etc/timezone');
                if (fileStdout && fileStdout.trim()) {
                    newTimezone = fileStdout.trim();
                    // Only log if timezone has changed
                    if (newTimezone !== this.cachedTimezone) {
                        console.log('Timezone detected via /etc/timezone:', newTimezone);
                    }
                }
            } catch (err) {
                console.error('Error reading /etc/timezone:', err);
                
                // Method 2: Use the timedatectl command as fallback
                try {
                    const { stdout: tzStdout } = await execPromise('timedatectl show --property=Timezone --value');
                    if (tzStdout && tzStdout.trim()) {
                        newTimezone = tzStdout.trim();
                        // Only log if timezone has changed
                        if (newTimezone !== this.cachedTimezone) {
                            console.log('Timezone detected via timedatectl:', newTimezone);
                        }
                    }
                } catch (err) {
                    console.error('Error with timedatectl method:', err);
                    
                    // Method 3: Parse from date command as last resort
                    try {
                        const { stdout: dateStdout } = await execPromise('date +%Z');
                        if (dateStdout && dateStdout.trim()) {
                            newTimezone = dateStdout.trim();
                            // Only log if timezone has changed
                            if (newTimezone !== this.cachedTimezone) {
                                console.log('Timezone abbreviation detected:', newTimezone);
                            }
                        }
                    } catch (err) {
                        console.error('Error getting timezone from date command:', err);
                    }
                }
            }
            
            // Only log timezone changes to reduce noise
            if (this.cachedTimezone !== newTimezone) {
                console.log(`System timezone changed: ${this.cachedTimezone || 'unknown'} -> ${newTimezone}`);
            }
            
            // Update cache
            this.cachedTimezone = newTimezone;
            this.lastTimezoneCheck = now;
            
            return newTimezone;
        } catch (error) {
            console.error('All timezone detection methods failed:', error);
            return this.cachedTimezone || 'Unknown';
        }
    }

    // New method to get complete node info
    static async getNodeInfo() {
        const now = Date.now();
        const systemInfo = await this.getSystemInfo();
        const networkInfo = this.getNetworkInfo();
        
        // Update node info if it's been more than 5 seconds
        if (now - this.nodeInfo.lastUpdate > 5000) {
            this.nodeInfo.lastUpdate = now;
            
            // Get sensor stats from database
            try {
                const sensorStats = await this.getSensorStats();
                this.nodeInfo.sensorStats = sensorStats;
            } catch (error) {
                console.error('Error getting sensor stats:', error);
            }
            
            // Get sync stats from database
            try {
                const syncStats = await this.getSyncStats();
                this.nodeInfo.syncStats = syncStats;
            } catch (error) {
                console.error('Error getting sync stats:', error);
            }
        }

        return {
            node_id: networkInfo.macAddress ? `node-${networkInfo.macAddress.split(':').slice(-3).join('').toUpperCase()}` : 'unknown',
            timestamp: new Date().toISOString(),
            system: {
                ip_address: networkInfo.ipAddress,
                runtime: this.formatUptime(Math.floor((now - this.serverStartTime) / 1000)),
                uptime: Math.floor((now - this.serverStartTime) / 1000),
                cpu_temp: systemInfo.system.cpuTemp,
                memory_usage: systemInfo.system.memory,
                disk_usage: systemInfo.system.disk
            },
            sensors: {
                total_sensors: this.nodeInfo.sensorStats.totalSensors || 0,
                active_sensors: this.nodeInfo.sensorStats.activeSensors || 0,
                last_reading_time: this.nodeInfo.sensorStats.lastReadingTime,
                reading_interval: 10, // Fixed interval
                sensor_stats: this.nodeInfo.sensorStats
            },
            mqtt: {
                connected: systemInfo.system.mqttConnected,
                broker_address: systemInfo.system.mqttBroker,
                last_message_time: this.nodeInfo.mqttStats.lastMessageTime,
                message_count: this.nodeInfo.mqttStats.messageCount
            },
            sync: {
                last_sync_time: this.nodeInfo.syncStats.lastSyncTime,
                last_sync_sequence: this.nodeInfo.syncStats.lastSyncSequence,
                total_records: this.nodeInfo.syncStats.totalRecords,
                pending_records: this.nodeInfo.syncStats.pendingRecords,
                sync_status: this.getSyncStatus()
            }
        };
    }

    // Helper method to get sensor stats
    static async getSensorStats() {
        // This would be implemented to query the database
        // For now, return mock data
        return {
            totalSensors: 2,
            activeSensors: 2,
            totalReadings: 1000,
            temperatureReadings: 500,
            humidityReadings: 500,
            firstReadingTime: new Date(Date.now() - 86400000).toISOString(), // 24 hours ago
            lastReadingTime: new Date().toISOString()
        };
    }

    // Helper method to get sync stats
    static async getSyncStats() {
        // This would be implemented to query the database
        // For now, return mock data
        return {
            lastSyncTime: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
            lastSyncSequence: 500,
            totalRecords: 1000,
            pendingRecords: 500
        };
    }

    // Helper method to determine sync status
    static getSyncStatus() {
        const stats = this.nodeInfo.syncStats;
        if (!stats.lastSyncTime) return 'none';
        if (stats.pendingRecords === 0) return 'full';
        return 'partial';
    }

    // Method to update sensor stats when new readings are added
    static updateSensorStats(reading) {
        this.nodeInfo.sensorStats.totalReadings++;
        if (reading.type === 'temperature') {
            this.nodeInfo.sensorStats.temperatureReadings++;
        } else if (reading.type === 'humidity') {
            this.nodeInfo.sensorStats.humidityReadings++;
        }
        
        if (!this.nodeInfo.sensorStats.firstReadingTime) {
            this.nodeInfo.sensorStats.firstReadingTime = reading.timestamp;
        }
        this.nodeInfo.sensorStats.lastReadingTime = reading.timestamp;
    }

    // Method to update sync stats after successful sync
    static updateSyncStats(sequence, count) {
        this.nodeInfo.syncStats.lastSyncTime = new Date().toISOString();
        this.nodeInfo.syncStats.lastSyncSequence = sequence;
        this.nodeInfo.syncStats.pendingRecords = Math.max(0, this.nodeInfo.syncStats.totalRecords - count);
    }

    // Method to update MQTT stats
    static updateMqttStats() {
        this.nodeInfo.mqttStats.messageCount++;
        this.nodeInfo.mqttStats.lastMessageTime = new Date().toISOString();
    }
    
    // Method to handle "info get" requests
    static async getInfoResponse() {
        const systemInfo = await this.getSystemInfo();
        const networkInfo = this.getNetworkInfo();
        const nodeId = networkInfo.macAddress ? `node-${networkInfo.macAddress.split(':').slice(-3).join('').toUpperCase()}` : 'unknown';
        
        // Get total values from database using the same query as getSequenceRange
        const totalValues = await new Promise((resolve) => {
            if (!this.dataDb) {
                console.error('Database not initialized');
                resolve(0);
                return;
            }
            this.dataDb.get('SELECT MIN(sequence_id) as min_seq, MAX(sequence_id) as max_seq, COUNT(*) as count FROM sensor_readings', [], (err, row) => {
                if (err) {
                    console.error('Error getting total values:', err);
                    resolve(0);
                } else {
                    resolve(row ? row.count : 0);
                }
            });
        });

        return {
            nodeId: nodeId,
            timestamp: new Date().toISOString(),
            ipAddress: networkInfo.ipAddress,
            hostname: os.hostname(),
            uptime: this.formatUptime(Math.floor((Date.now() - this.serverStartTime) / 1000)),
            systemTimezone: await this.getSystemTimezone(),
            localValues: totalValues,
            cpuTemp: systemInfo.system.cpuTemp,
            internetStatus: systemInfo.system.internetStatus,
            protocol_version: "1.0"
        };
    }
}

module.exports = SystemInfo; 