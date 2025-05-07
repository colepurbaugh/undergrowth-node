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
                console.error('Error getting CPU temperature:', error);
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
}

module.exports = SystemInfo; 