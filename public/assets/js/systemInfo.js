const os = require('os');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class SystemInfo {
    static serverStartTime = Date.now();

    static async getSystemInfo() {
        try {
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

            return {
                system: {
                    piUptime,
                    serverUptime,
                    ipAddress: networkInfo.ipAddress,
                    macAddress: networkInfo.macAddress,
                    hostname,
                    cpuTemp
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
                    cpuTemp: 'Error'
                }
            };
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
                if (iface.family === 'IPv4' && !iface.internal) {
                    ipAddress = iface.address;
                    macAddress = iface.mac || 'Not available';
                    break;
                }
            }
            if (ipAddress !== 'Not available') break;
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
}

module.exports = SystemInfo; 