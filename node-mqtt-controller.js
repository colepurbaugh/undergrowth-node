/**
 * MQTT Controller for Undergrowth Node
 * Handles MQTT broker discovery, connection, and message handling
 * 
 * This module provides a unified interface for all MQTT operations,
 * including automatic broker discovery and connection management.
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
     * @returns {Promise<Object>} Promise that resolves when connected to MQTT broker
     */
    connectToBroker() {
        if (!this.state.brokerAddress || !this.state.brokerPort) {
            throw new Error('Broker address not discovered');
        }

        const brokerUrl = `mqtt://${this.state.brokerAddress}:${this.state.brokerPort}`;
        console.log('Connecting to MQTT broker at:', brokerUrl);

        return new Promise((resolve, reject) => {
            const client = mqtt.connect(brokerUrl, {
                clientId: this.nodeId,
                clean: true,
                reconnectPeriod: 5000
            });

            // Set connection timeout
            const connectionTimeout = setTimeout(() => {
                if (!client.connected) {
                    const error = new Error('MQTT connection timeout');
                    client.removeAllListeners();
                    client.end(true);
                    reject(error);
                }
            }, 10000); // 10 second timeout

            client.on('connect', () => {
                console.log('Connected to MQTT broker');
                this.state.connectionStatus = 'connected';
                this.state.lastConnectionTime = new Date();
                this.state.reconnectionAttempts = 0;
                this.emit('connect');
                
                // Connection successful, clear timeout
                clearTimeout(connectionTimeout);
                
                // Store the client and resolve the promise
                this.mqttClient = client;
                resolve(client);
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
                // Emit our own error event, but handle it to prevent node from crashing
                // Node crashes on 'error' events that have no listeners
                try {
                    // Check if we have error listeners (external code listening for errors)
                    const hasErrorListeners = this.listenerCount('error') > 0;
                    
                    if (hasErrorListeners) {
                        // If someone is listening for errors, emit the event
                        this.emit('error', err);
                    } else {
                        // Otherwise just log it to prevent crash
                        console.error('Unhandled MQTT error (suppressed to prevent crash):', err.message);
                    }
                } catch (emitError) {
                    // Even emitting the error failed, just log it
                    console.error('Error while handling MQTT error:', emitError);
                }
                
                // If not connected yet, reject the promise
                if (!client.connected && !this.mqttClient) {
                    clearTimeout(connectionTimeout);
                    reject(err);
                }
            });

            // Update last message time on any message
            client.on('message', (topic, message) => {
                this.updateLastMessageTime();
                // Emit the message event for external handlers
                this.emit('message', topic, message);
            });
        });
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
            // If MQTT is not available or connected, don't throw an error, just resolve with a "not sent" status
            if (!this.mqttClient) {
                console.log(`MQTT client not available for publishing to ${topic}, skipping`);
                resolve({ sent: false, reason: 'MQTT client not initialized' });
                return;
            }
            
            if (!this.mqttClient.connected) {
                console.log(`MQTT client not connected for publishing to ${topic}, skipping`);
                resolve({ sent: false, reason: 'MQTT client not connected' });
                return;
            }

            try {
                // Add protocol version to all object messages
                if (typeof message === 'object') {
                    message.protocol_version = "1.0";
                }
                
                // Convert message to string if it's an object
                const messageStr = typeof message === 'object' ? JSON.stringify(message) : message;

                this.mqttClient.publish(topic, messageStr, options, (err) => {
                    if (err) {
                        console.error(`Error publishing to ${topic}:`, err);
                        resolve({ sent: false, reason: err.message });
                    } else {
                        resolve({ sent: true });
                    }
                });
            } catch (error) {
                console.error(`Exception while trying to publish to ${topic}:`, error);
                resolve({ sent: false, reason: error.message });
            }
        });
    }

    /**
     * Publish sensor data to MQTT
     * @param {Object} sensor1Data - Data from sensor 1
     * @param {Object} sensor2Data - Data from sensor 2
     * @param {Object} configuredSensorData - Data from configured sensors
     * @returns {Promise<Object>} Result of the publish operation
     */
    async publishSensorData(sensor1Data, sensor2Data, configuredSensorData = {}) {
        if (!this.mqttClient || !this.mqttClient.connected) {
            return { sent: false, reason: 'MQTT client not connected' };
        }
        
        // Create standardized data structure
        const readings = [];
        
        // Process legacy sensors (0x38 and 0x39)
        if (sensor1Data) {
            // Add temperature reading
            readings.push({
                sensor_id: "aht10_0x38",
                type: "temperature",
                value: sensor1Data.temperature,
                unit: "°F"
            });
            
            // Add humidity reading
            readings.push({
                sensor_id: "aht10_0x38",
                type: "humidity",
                value: sensor1Data.humidity,
                unit: "%"
            });
        }
        
        if (sensor2Data) {
            // Add temperature reading
            readings.push({
                sensor_id: "aht10_0x39",
                type: "temperature",
                value: sensor2Data.temperature,
                unit: "°F"
            });
            
            // Add humidity reading
            readings.push({
                sensor_id: "aht10_0x39",
                type: "humidity",
                value: sensor2Data.humidity,
                unit: "%"
            });
        }
        
        // Process any configured sensors from the database
        for (const [address, sensorData] of Object.entries(configuredSensorData)) {
            if (!sensorData) continue;
            
            const config = sensorData.config || {};
            // Determine sensor type (default to 'aht10' if not specified)
            const sensorType = config.type?.toLowerCase() || 'aht10';
            
            // Create standardized sensor_id
            const sensorId = `${sensorType}_${address}`;
            
            // Apply calibration if configured
            const tempValue = (sensorData.temperature * (config.calibration_scale || 1)) + 
                             (config.calibration_offset || 0);
            
            // Add temperature reading
            readings.push({
                sensor_id: sensorId,
                type: "temperature",
                value: tempValue,
                unit: "°F"
            });
            
            // Add humidity reading
            readings.push({
                sensor_id: sensorId,
                type: "humidity",
                value: sensorData.humidity,
                unit: "%"
            });
        }
        
        // Create the standardized message
        const data = {
            timestamp: new Date().toISOString(),
            node_id: this.nodeId,
            readings: readings
        };
        
        // Publish to the sensor data topic according to documentation
        return await this.publish(`undergrowth/nodes/${this.nodeId}/responses/sensors`, data);
    }

    /**
     * Publish node status to MQTT
     * @param {Object} status - Node status information
     * @returns {Promise<Object>} Result of the publish operation
     */
    async publishNodeStatus(status) {
        if (!this.mqttClient || !this.mqttClient.connected) {
            return { sent: false, reason: 'MQTT client not connected' };
        }
        
        // Ensure we use the standardized node_id field
        if (status && !status.node_id && status.nodeId) {
            status.node_id = status.nodeId;
            delete status.nodeId;
        }
        
        return await this.publish(`undergrowth/nodes/${this.nodeId}/responses/status`, status, { qos: 1, retain: true });
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
            
            // Add a global error handler to prevent crashing
            this.on('error', (err) => {
                console.error('MQTT error caught by global handler:', err.message);
                // No need to do anything - we just need to have this listener
                // to prevent Node from crashing due to unhandled error events
            });
            
            console.log('Attempting to discover MQTT broker...');
            const broker = await this.discoverBroker();
            console.log(`Found MQTT broker: ${broker.address}:${broker.port}`);
            
            // Connect to broker and wait for connection to establish
            const client = await this.connectToBroker();
            console.log('MQTT client connected successfully');
            
            // Only subscribe after connection is established
            try {
                // Subscribe to topics
                await this.subscribe(`${this.nodeId}/#`);
                await this.subscribe(`undergrowth/server/requests/${this.nodeId}/#`);
                console.log('Successfully subscribed to required topics');
            } catch (subscribeError) {
                console.error('Error subscribing to topics:', subscribeError.message);
                // Don't fail initialization if subscription fails, just report it
            }

            return true;
        } catch (error) {
            console.log('MQTT broker discovery/connection failed:', error.message);
            console.log('Node will run in standalone mode. MQTT features disabled.');
            
            // Schedule retry with exponential backoff
            const retryMinutes = Math.min(30, Math.pow(2, this.state.reconnectionAttempts));
            this.state.reconnectionAttempts++;
            console.log(`Will retry MQTT connection in ${retryMinutes} minutes`);
            
            this.brokerRetryTimeout = setTimeout(() => {
                this.initialize().catch(err => {
                    console.error('Error during scheduled MQTT retry:', err.message);
                    // Don't let this crash the app
                });
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