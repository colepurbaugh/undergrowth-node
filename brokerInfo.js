const mqtt = require('mqtt');
const { Bonjour } = require('bonjour-service');

class BrokerInfo {
    constructor() {
        this.brokerAddress = null;
        this.brokerPort = null;
        this.connectionStatus = 'disconnected';
        this.lastConnectionTime = null;
        this.connectionDuration = 0;
        this.reconnectionAttempts = 0;
        this.lastMessageTime = null;
        this.topicsSubscribed = [];
        this.client = null;
    }

    async discoverBroker() {
        return new Promise((resolve, reject) => {
            const bonjour = new Bonjour();
            const browser = bonjour.find({ type: 'mqtt' });
            
            browser.on('up', (service) => {
                console.log('Found MQTT broker:', service);
                this.brokerAddress = service.addresses[0];
                this.brokerPort = service.port;
                browser.stop();
                bonjour.destroy();
                resolve({ address: this.brokerAddress, port: this.brokerPort });
            });

            browser.on('down', (service) => {
                console.log('MQTT broker went down:', service);
            });

            // Timeout after 10 seconds
            setTimeout(() => {
                browser.stop();
                bonjour.destroy();
                reject(new Error('MQTT broker discovery timeout'));
            }, 10000);
        });
    }

    connectToBroker(nodeId) {
        if (!this.brokerAddress || !this.brokerPort) {
            throw new Error('Broker address not discovered');
        }

        const brokerUrl = `mqtt://${this.brokerAddress}:${this.brokerPort}`;
        console.log('Connecting to MQTT broker at:', brokerUrl);

        this.client = mqtt.connect(brokerUrl, {
            clientId: nodeId,
            clean: true,
            reconnectPeriod: 5000
        });

        this.client.on('connect', () => {
            console.log('Connected to MQTT broker');
            this.connectionStatus = 'connected';
            this.lastConnectionTime = new Date();
            this.reconnectionAttempts = 0;
        });

        this.client.on('disconnect', () => {
            console.log('Disconnected from MQTT broker');
            this.connectionStatus = 'disconnected';
        });

        this.client.on('reconnect', () => {
            console.log('Reconnecting to MQTT broker...');
            this.reconnectionAttempts++;
        });

        this.client.on('error', (err) => {
            console.error('MQTT error:', err);
        });

        // Update last message time on any message
        this.client.on('message', () => {
            this.updateLastMessageTime();
        });

        return this.client;
    }

    getBrokerInfo() {
        // Calculate current connection duration if connected
        if (this.connectionStatus === 'connected' && this.lastConnectionTime) {
            this.connectionDuration = Date.now() - this.lastConnectionTime;
        }

        // Format connection duration
        let durationStr = 'Not connected';
        if (this.connectionDuration) {
            const hours = Math.floor(this.connectionDuration / (1000 * 60 * 60));
            const minutes = Math.floor((this.connectionDuration % (1000 * 60 * 60)) / (1000 * 60));
            if (hours > 0) {
                durationStr = `${hours}h ${minutes}m`;
            } else {
                durationStr = `${minutes}m`;
            }
        }

        return {
            status: this.connectionStatus,
            address: this.brokerAddress,
            port: this.brokerPort,
            lastConnection: this.lastConnectionTime,
            connectionDuration: durationStr,
            reconnectionAttempts: this.reconnectionAttempts,
            lastMessage: this.lastMessageTime,
            topicsSubscribed: this.topicsSubscribed
        };
    }

    updateLastMessageTime() {
        this.lastMessageTime = new Date();
    }

    addSubscribedTopic(topic) {
        if (!this.topicsSubscribed.includes(topic)) {
            this.topicsSubscribed.push(topic);
        }
    }

    removeSubscribedTopic(topic) {
        this.topicsSubscribed = this.topicsSubscribed.filter(t => t !== topic);
    }
}

module.exports = BrokerInfo; 