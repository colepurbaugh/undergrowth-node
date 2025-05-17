/**
 * MQTT module for Undergrowth Node
 * Handles MQTT broker discovery, connection, and message handling
 */

const mqtt = require('mqtt');
const { Bonjour } = require('bonjour-service');
const EventEmitter = require('events');

class MQTTController extends EventEmitter {
    constructor(nodeId) {
        super();
        this.nodeId = nodeId;
        this.mqttClient = null;
        this.brokerDiscoveryActive = false;
        this.brokerRetryTimeout = null;
        this.state = {
            brokerAddress: null,
            brokerPort: null,
            connectionStatus: 'disconnected',
            lastConnectionTime: null,
            connectionDuration: 0,
            reconnectionAttempts: 0,
            lastMessageTime: null,
            topicsSubscribed: []
        };
    }

    /**
     * Discover MQTT broker using Bonjour
     * @returns {Promise<Object>} Broker information (address, port)
     */
    async discoverBroker() {
        if (this.brokerDiscoveryActive) {
            return Promise.reject(new Error('Broker discovery already active'));
        }
        
        this.brokerDiscoveryActive = true;
        return new Promise((resolve, reject) => {
            const bonjour = new Bonjour();
            const browser = bonjour.find({ type: 'mqtt' });
            
            browser.on('up', (service) => {
                this.state.brokerAddress = service.addresses[0];
                this.state.brokerPort = service.port;
                browser.stop();
                bonjour.destroy();
                this.brokerDiscoveryActive = false;
                resolve({ address: this.state.brokerAddress, port: this.state.brokerPort });
            });

            browser.on('down', (service) => {
                console.log('MQTT broker went down:', service);
            });

            // Timeout after 10 seconds
            setTimeout(() => {
                browser.stop();
                bonjour.destroy();
                this.brokerDiscoveryActive = false;
                reject(new Error('MQTT broker discovery timeout'));
            }, 10000);
        });
    }

    /**
     * Connect to MQTT broker
     * @returns {Object} MQTT client
     */
    connectToBroker() {
        if (!this.state.brokerAddress || !this.state.brokerPort) {
            throw new Error('Broker address not discovered');
        }

        const brokerUrl = `mqtt://${this.state.brokerAddress}:${this.state.brokerPort}`;
        console.log('Connecting to MQTT broker at:', brokerUrl);

        const client = mqtt.connect(brokerUrl, {
            clientId: this.nodeId,
            clean: true,
            reconnectPeriod: 5000
        });

        client.on('connect', () => {
            console.log('Connected to MQTT broker');
            this.state.connectionStatus = 'connected';
            this.state.lastConnectionTime = new Date();
            this.state.reconnectionAttempts = 0;
            this.emit('connect');
        });

        client.on('disconnect', () => {
            console.log('Disconnected from MQTT broker');
            this.state.connectionStatus = 'disconnected';
            this.emit('disconnect');
        });

        client.on('reconnect', () => {
            console.log('Reconnecting to MQTT broker...');
            this.state.reconnectionAttempts++;
            this.emit('reconnect');
        });

        client.on('error', (err) => {
            console.error('MQTT error:', err);
            this.emit('error', err);
        });

        // Update last message time on any message
        client.on('message', (topic, message) => {
            this.updateLastMessageTime();
            // Emit the message event for external handlers
            this.emit('message', topic, message);
        });

        this.mqttClient = client;
        return client;
    }

    /**
     * Get broker information
     * @returns {Object} Broker information
     */
    getBrokerInfo() {
        // Calculate current connection duration if connected
        if (this.state.connectionStatus === 'connected' && this.state.lastConnectionTime) {
            this.state.connectionDuration = Date.now() - this.state.lastConnectionTime;
        }

        // Format connection duration
        let durationStr = 'Not connected';
        if (this.state.connectionDuration) {
            const hours = Math.floor(this.state.connectionDuration / (1000 * 60 * 60));
            const minutes = Math.floor((this.state.connectionDuration % (1000 * 60 * 60)) / (1000 * 60));
            if (hours > 0) {
                durationStr = `${hours}h ${minutes}m`;
            } else {
                durationStr = `${minutes}m`;
            }
        }

        return {
            connected: this.mqttClient ? this.mqttClient.connected : false,
            status: this.state.connectionStatus,
            address: this.state.brokerAddress,
            port: this.state.brokerPort,
            lastConnection: this.state.lastConnectionTime,
            connectionDuration: durationStr,
            reconnectionAttempts: this.state.reconnectionAttempts,
            lastMessage: this.state.lastMessageTime,
            topicsSubscribed: this.state.topicsSubscribed
        };
    }

    /**
     * Update last message time
     */
    updateLastMessageTime() {
        this.state.lastMessageTime = new Date();
    }

    /**
     * Add subscribed topic
     * @param {string} topic - Topic to add
     */
    addSubscribedTopic(topic) {
        if (!this.state.topicsSubscribed.includes(topic)) {
            this.state.topicsSubscribed.push(topic);
        }
    }

    /**
     * Remove subscribed topic
     * @param {string} topic - Topic to remove
     */
    removeSubscribedTopic(topic) {
        this.state.topicsSubscribed = this.state.topicsSubscribed.filter(t => t !== topic);
    }

    /**
     * Subscribe to topic
     * @param {string} topic - Topic to subscribe to
     * @returns {Promise} Promise that resolves when subscription is complete
     */
    subscribe(topic) {
        return new Promise((resolve, reject) => {
            if (!this.mqttClient || !this.mqttClient.connected) {
                reject(new Error('MQTT client not connected'));
                return;
            }

            this.mqttClient.subscribe(topic, (err) => {
                if (err) {
                    console.error(`Error subscribing to ${topic}:`, err);
                    reject(err);
                } else {
                    console.log(`Subscribed to topic: ${topic}`);
                    this.addSubscribedTopic(topic);
                    resolve();
                }
            });
        });
    }

    /**
     * Publish message to topic
     * @param {string} topic - Topic to publish to
     * @param {Object|string} message - Message to publish
     * @param {Object} options - MQTT publish options
     * @returns {Promise} Promise that resolves when message is published
     */
    publish(topic, message, options = { qos: 1 }) {
        return new Promise((resolve, reject) => {
            if (!this.mqttClient || !this.mqttClient.connected) {
                reject(new Error('MQTT client not connected'));
                return;
            }

            // Convert message to string if it's an object
            const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;

            this.mqttClient.publish(topic, messageStr, options, (err) => {
                if (err) {
                    console.error(`Error publishing to ${topic}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Publish sensor data to MQTT
     * @param {Object} sensor1Data - Data from sensor 1
     * @param {Object} sensor2Data - Data from sensor 2
     * @param {Object} configuredSensorData - Data from configured sensors
     */
    publishSensorData(sensor1Data, sensor2Data, configuredSensorData = {}) {
        if (!this.mqttClient || !this.mqttClient.connected) return;
        
        const sensors = {};
        
        // Add legacy sensors for backward compatibility
        if (sensor1Data) {
            sensors.sensor1 = {
                address: '0x38',
                temperature: sensor1Data.temperature,
                humidity: sensor1Data.humidity
            };
        }
        
        if (sensor2Data) {
            sensors.sensor2 = {
                address: '0x39',
                temperature: sensor2Data.temperature,
                humidity: sensor2Data.humidity
            };
        }
        
        // Add configured sensors
        for (const [address, sensorObj] of Object.entries(sensors)) {
            if (configuredSensorData[address]) {
                const reading = configuredSensorData[address];
                const config = sensorObj.config || {};
                
                // Apply calibration if configured
                const tempValue = (reading.temperature * (config.calibration_scale || 1)) + 
                                 (config.calibration_offset || 0);
                
                sensors[`sensor_${config.id || address}`] = {
                    id: config.id,
                    address: address,
                    type: config.type || 'unknown',
                    name: config.name,
                    temperature: tempValue,
                    humidity: reading.humidity
                };
            }
        }
        
        const data = {
            nodeId: this.nodeId,
            timestamp: new Date().toISOString(),
            sensors
        };
        
        this.publish(`undergrowth/nodes/${this.nodeId}/sensors`, data);
    }

    /**
     * Publish node status to MQTT
     * @param {Object} status - Node status information
     */
    publishNodeStatus(status) {
        if (!this.mqttClient || !this.mqttClient.connected) return;
        
        this.publish(`undergrowth/nodes/${this.nodeId}/status`, status, { qos: 1, retain: true });
    }

    /**
     * Initialize MQTT connection with automatic retry
     */
    async initialize() {
        try {
            // Clear any existing retry timeout
            if (this.brokerRetryTimeout) {
                clearTimeout(this.brokerRetryTimeout);
                this.brokerRetryTimeout = null;
            }
            
            console.log('Attempting to discover MQTT broker...');
            const broker = await this.discoverBroker();
            console.log(`Found MQTT broker: ${broker.address}:${broker.port}`);
            
            this.connectToBroker();
            
            // Subscribe to topics
            this.subscribe(`${this.nodeId}/#`);
            this.subscribe(`undergrowth/server/requests/${this.nodeId}/#`);

            return true;
        } catch (error) {
            console.log('MQTT broker discovery failed:', error.message);
            console.log('Node will run in standalone mode. MQTT features disabled.');
            
            // Schedule retry with exponential backoff
            const retryMinutes = Math.min(30, Math.pow(2, this.state.reconnectionAttempts));
            this.state.reconnectionAttempts++;
            console.log(`Will retry MQTT connection in ${retryMinutes} minutes`);
            
            this.brokerRetryTimeout = setTimeout(() => {
                this.initialize();
            }, retryMinutes * 60 * 1000);
            
            return false;
        }
    }

    /**
     * Close MQTT connection and clean up
     */
    close() {
        if (this.brokerRetryTimeout) {
            clearTimeout(this.brokerRetryTimeout);
            this.brokerRetryTimeout = null;
        }
        
        if (this.mqttClient) {
            this.mqttClient.end();
            this.mqttClient = null;
        }
    }
}

module.exports = MQTTController; 