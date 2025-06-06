const { Gpio } = require('pigpio');

class GpioController {
    constructor(configDb, broadcastPwmStateCallback) {
        this.configDb = configDb;
        this.broadcastPwmStateCallback = broadcastPwmStateCallback;
        this.pwmPins = {
            12: null,
            13: null,
            18: null,
            19: null
        };
        this.pwmEnabled = false;
    }

    async initialize() {
        this._initPwmPins();
        if (this.pwmEnabled) {
            await this._loadPwmStates();
        }
        return this.pwmEnabled;
    }

    _initPwmPins() {
        try {
            Object.keys(this.pwmPins).forEach(pin => {
                this.pwmPins[pin] = new Gpio(parseInt(pin), { mode: Gpio.OUTPUT });
                this.pwmPins[pin].pwmFrequency(800); // Default frequency
                this.pwmPins[pin].pwmWrite(0);      // Default duty cycle
            });
            this.pwmEnabled = true;
            console.log('PWM pins initialized successfully by GpioController');
        } catch (error) {
            console.warn('GpioController: PWM initialization failed:', error.message);
            console.warn('GpioController: PWM functionality will be disabled');
            this.pwmEnabled = false;
        }
    }

    async _loadPwmStates() {
        if (!this.pwmEnabled) {
            console.warn('GpioController: PWM disabled, cannot load states.');
            return;
        }
        return new Promise((resolve, reject) => {
            this.configDb.all('SELECT pin, value, enabled FROM manual_pwm_states', [], (err, rows) => {
                if (err) {
                    console.error('GpioController: Error loading PWM states:', err);
                    reject(err);
                    return;
                }
                
                rows.forEach(row => {
                    const pin = row.pin;
                    if (this.pwmPins[pin]) {
                        // Store for reference, not directly used by pigpio Gpio object
                        // this.pwmPins[pin].value = row.value;
                        // this.pwmPins[pin].enabled = row.enabled;
                        // this.pwmPins[pin].normal_enable = row.enabled;
                        console.log(`GpioController: Loaded PWM state for GPIO${pin}: value=${row.value}, enabled=${row.enabled}`);
                        
                        if (row.enabled === 1) {
                            const hardwareValue = Math.floor((row.value / 1023) * 255);
                            console.log(`GpioController: Setting initial PWM for GPIO${pin}: ${row.value}/1023 -> ${hardwareValue}/255`);
                            try {
                                this.pwmPins[pin].pwmWrite(hardwareValue);
                                // this.pwmPins[pin]._dbValue = row.value; // Store DB value for reference
                            } catch (e) {
                                console.error(`GpioController: Error setting initial PWM for GPIO${pin}:`, e.message);
                            }
                        } else {
                            try {
                                this.pwmPins[pin].pwmWrite(0);
                                // this.pwmPins[pin]._dbValue = 0;
                            } catch (e) {
                                console.error(`Error setting initial PWM for GPIO${pin} to 0:`, e.message);
                            }
                        }
                    }
                });
                resolve();
            });
        });
    }

    async _isSystemSafe() {
        return new Promise((resolve) => {
            this.configDb.get('SELECT value FROM safety_state WHERE key = ?', ['emergency_stop'], (err, row) => {
                if (err || !row) {
                    console.error('GpioController: Error checking emergency stop state:', err);
                    resolve(false);
                    return;
                }
                const isEmergencyStop = row.value === 1;
                if (isEmergencyStop) {
                    resolve(false);
                    return;
                }
                this.configDb.get('SELECT value FROM safety_state WHERE key = ?', ['normal_enable'], (err, row) => {
                    if (err || !row) {
                        console.error('GpioController: Error checking normal enable state:', err);
                        resolve(false);
                        return;
                    }
                    resolve(row.value === 1);
                });
            });
        });
    }

    async _getCurrentMode() {
        return new Promise((resolve, reject) => {
            this.configDb.get('SELECT value FROM system_state WHERE key = ?', ['mode'], (err, row) => {
                if (err) {
                    console.error('GpioController: Error getting mode:', err);
                    reject(err); // Default to manual mode on error
                } else {
                    resolve(row ? row.value : 1); // Default to manual mode (1)
                }
            });
        });
    }


    async applyPwmStatesFromDb() {
        if (!this.pwmEnabled) {
            console.warn('GpioController: PWM disabled, cannot apply states from DB.');
            return;
        }
        console.log('GpioController: Manually applying PWM states from database...');

        const isSafe = await this._isSystemSafe();
        if (!isSafe) {
            console.log('GpioController: System not in safe state, PWM values will not be applied from DB.');
            this.emergencyStopOutputs(); // Ensure outputs are off
            return;
        }

        try {
            const mode = await this._getCurrentMode();
            console.log(`GpioController: Current mode for DB apply: ${mode === 0 ? 'automatic' : 'manual'} (${mode})`);
            
            const statesTable = mode === 0 ? 'auto_pwm_states' : 'manual_pwm_states';
            
            this.configDb.all(`SELECT pin, value, enabled FROM ${statesTable}`, [], (err, rows) => {
                if (err) {
                    console.error(`GpioController: Error loading ${statesTable}:`, err);
                    return;
                }
                
                console.log(`GpioController: Found ${rows.length} PWM states in ${statesTable} to apply.`);
                
                rows.forEach(row => {
                    const pin = row.pin;
                    if (this.pwmPins[pin]) {
                        if (row.enabled === 1) {
                            const hardwareValue = Math.floor((row.value / 1023) * 255);
                            console.log(`GpioController: Applying PWM for GPIO${pin}: ${row.value}/1023 -> ${hardwareValue}/255`);
                            try {
                                this.pwmPins[pin].pwmWrite(hardwareValue);
                            } catch (e) {
                                console.error(`GpioController: Error applying PWM for GPIO${pin}:`, e.message);
                            }
                        } else {
                            console.log(`GpioController: GPIO${pin} is disabled in ${statesTable}, setting to 0`);
                            try {
                                this.pwmPins[pin].pwmWrite(0);
                            } catch (e) {
                                console.error(`Error setting PWM for GPIO${pin} to 0:`, e.message);
                            }
                        }
                    }
                });
            });
        } catch (error) {
            console.error('GpioController: Error in applyPwmStatesFromDb:', error);
        }
    }

    async setPWM(pin, value, socket) { // socket is passed for emitting pwmError
        if (!this.pwmEnabled) {
            console.warn('GpioController: PWM disabled, cannot set PWM.');
            if (socket) socket.emit('pwmError', { pin, message: 'PWM system disabled on server.', blocked: true });
            return;
        }
        if (!this.pwmPins[pin]) {
            console.error(`GpioController: Invalid pin ${pin} for setPWM.`);
            if (socket) socket.emit('pwmError', { pin, message: 'Invalid pin.', blocked: false });
            return;
        }

        const isSafe = await this._isSystemSafe();
        if (!isSafe) {
            console.log('GpioController: System not safe, PWM set blocked.');
            if (socket) socket.emit('pwmError', { pin, message: 'System is in emergency stop or not enabled, cannot set PWM.', blocked: true });
            return;
        }

        const currentMode = await this._getCurrentMode();
        if (currentMode === 0) { // 0 = automatic
            console.log('GpioController: In automatic mode, manual PWM set blocked.');
            if (socket) socket.emit('pwmError', { pin, message: 'Cannot change PWM in automatic mode.', blocked: true });
            return;
        }

        console.log(`GpioController: Setting PWM for pin ${pin} to ${value}`);
        this.configDb.run(
            'UPDATE manual_pwm_states SET value = ?, last_modified = CURRENT_TIMESTAMP WHERE pin = ?',
            // 'INSERT OR REPLACE INTO manual_pwm_states (pin, value, enabled, last_modified) VALUES (?, ?, (SELECT enabled FROM manual_pwm_states WHERE pin = ?), CURRENT_TIMESTAMP)',
            [value, pin], // Using UPDATE ensures enabled state is preserved
            (err) => {
                if (err) {
                    console.error('GpioController: Error updating PWM value in database:', err);
                    if (socket) socket.emit('pwmError', { pin, message: 'Database error.', blocked: false });
                    return;
                }
                
                this.configDb.get('SELECT enabled FROM manual_pwm_states WHERE pin = ?', [pin], (err, row) => {
                    if (err || !row) {
                        console.error('GpioController: Error getting enabled state for hardware update:', err);
                        return; // Still broadcast, DB is updated
                    }
                    if (row.enabled === 1) {
                        const hardwareValue = Math.floor((value / 1023) * 255);
                        console.log(`GpioController: Writing hardware PWM value ${hardwareValue} (from ${value}) to pin ${pin}`);
                        try {
                            this.pwmPins[pin].pwmWrite(hardwareValue);
                        } catch (e) {
                            console.error(`GpioController: Error writing PWM to hardware pin ${pin}:`, e.message);
                        }
                    }
                    this.broadcastPwmStateCallback();
                });
            }
        );
    }

    async togglePWM(pin, enabled, socket) { // socket is passed for emitting pwmError
        if (!this.pwmEnabled) {
            console.warn('GpioController: PWM disabled, cannot toggle PWM.');
            if (socket) socket.emit('pwmError', { pin, message: 'PWM system disabled on server.', blocked: true });
            return;
        }
        if (!this.pwmPins[pin]) {
            console.error(`GpioController: Invalid pin ${pin} for togglePWM.`);
            if (socket) socket.emit('pwmError', { pin, message: 'Invalid pin.', blocked: false });
            return;
        }

        const isSafe = await this._isSystemSafe();
        if (!isSafe) {
            console.log('GpioController: System not safe, PWM toggle blocked.');
            if (socket) socket.emit('pwmError', { pin, message: 'System is in emergency stop or not enabled, cannot toggle PWM.', blocked: true });
            return;
        }

        const currentMode = await this._getCurrentMode();
        if (currentMode === 0) { // 0 = automatic
            console.log('GpioController: In automatic mode, manual PWM toggle blocked.');
             if (socket) socket.emit('pwmError', { pin, message: 'Cannot change PWM in automatic mode.', blocked: true });
            return;
        }

        console.log(`GpioController: Toggling PWM for pin ${pin} to ${enabled ? 'enabled' : 'disabled'}`);
        this.configDb.run('UPDATE manual_pwm_states SET enabled = ? WHERE pin = ?', [enabled ? 1 : 0, pin], (err) => {
            if (err) {
                console.error('GpioController: Error updating PWM enabled state in database:', err);
                return; // DB error, don't proceed to hardware or broadcast
            }

            if (enabled) {
                this.configDb.get('SELECT value FROM manual_pwm_states WHERE pin = ?', [pin], (err, row) => {
                    if (err || !row) {
                        console.error('GpioController: Error getting value for enabling PWM:', err);
                        this.broadcastPwmStateCallback(); // Broadcast state even if value fetch fails
                        return;
                    }
                    const hardwareValue = Math.floor((row.value / 1023) * 255);
                    console.log(`GpioController: Enabling GPIO${pin} to hardware value ${hardwareValue} (DB value ${row.value})`);
                    try {
                        this.pwmPins[pin].pwmWrite(hardwareValue);
                    } catch (e) {
                        console.error(`GpioController: Error enabling PWM on hardware pin ${pin}:`, e.message);
                    }
                    this.broadcastPwmStateCallback();
                });
            } else {
                console.log(`GpioController: Disabling GPIO${pin}, setting hardware to 0`);
                try {
                    this.pwmPins[pin].pwmWrite(0);
                } catch (e) {
                    console.error(`GpioController: Error disabling PWM on hardware pin ${pin}:`, e.message);
                }
                this.broadcastPwmStateCallback();
            }
        });
    }

    async updateHardwareForControlLoop(safetyStates, mode, events) {
        if (!this.pwmEnabled) return;

        const isEmergencyStop = safetyStates.emergency_stop === 1; // Ensure it's number 1
        const isNormalEnable = safetyStates.normal_enable === 1; // Ensure it's number 1

        if (isEmergencyStop || !isNormalEnable) {
            this.emergencyStopOutputs();
            return;
        }

        if (mode === 0) { // Automatic mode
            const now = new Date();
            const currentTime = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
            
            // Get all events (time-based and threshold-based) with priority consideration
            const allEvents = await new Promise((resolve, reject) => {
                this.configDb.all('SELECT * FROM events WHERE enabled = 1 ORDER BY priority ASC, time', [], (err, rows) => {
                    if (err) reject(err); else resolve(rows || []);
                });
            });
            
            // Separate time-based and threshold-based events
            const timeEvents = allEvents.filter(e => e.trigger_type === 'time' || !e.trigger_type);
            const thresholdEvents = allEvents.filter(e => e.trigger_type !== 'time' && e.trigger_type);
            
            // Find active time-based events (the most recent past event or next future event for each GPIO)
            const activeTimeEvents = {};
            const eventsByGpio = {};
            
            // Group time events by GPIO
            timeEvents.forEach(event => {
                if (!eventsByGpio[event.gpio]) {
                    eventsByGpio[event.gpio] = [];
                }
                eventsByGpio[event.gpio].push(event);
            });
            
            // For each GPIO, find the controlling time event
            Object.keys(eventsByGpio).forEach(gpio => {
                const gpioEvents = eventsByGpio[gpio];
                let activeEvent = null;
                
                // Convert events to include time in seconds for easier comparison
                const eventsWithTime = gpioEvents.map(event => {
                    const [hours, minutes, seconds] = event.time.split(':').map(Number);
                    let eventTime = hours * 3600 + minutes * 60 + seconds;
                    
                    // Handle day boundary: if event time is significantly less than current time,
                    // it's likely tomorrow's event (e.g., 00:00:00 when current time is 21:00:00)
                    if (eventTime < currentTime && (currentTime - eventTime) > 12 * 3600) {
                        eventTime += 24 * 3600; // Add 24 hours to represent next day
                    }
                    
                    return { ...event, timeSeconds: eventTime };
                });
                
                console.log(`GPIO${gpio} time analysis:`, {
                    currentTime: currentTime,
                    currentTimeFormatted: `${Math.floor(currentTime/3600)}:${Math.floor((currentTime%3600)/60)}:${currentTime%60}`,
                    events: eventsWithTime.map(e => ({
                        time: e.time,
                        timeSeconds: e.timeSeconds,
                        pwm: e.pwm_value,
                        isFuture: e.timeSeconds > currentTime
                    }))
                });
                
                // Find the most recent past event or the next upcoming event
                let mostRecentPast = null;
                let nextUpcoming = null;
                
                eventsWithTime.forEach(event => {
                    if (event.timeSeconds <= currentTime) {
                        // This is a past event
                        if (!mostRecentPast || event.timeSeconds > mostRecentPast.timeSeconds) {
                            mostRecentPast = event;
                        }
                    } else {
                        // This is a future event
                        if (!nextUpcoming || event.timeSeconds < nextUpcoming.timeSeconds) {
                            nextUpcoming = event;
                        }
                    }
                });
                
                // Choose the controlling event: prefer most recent past, fallback to next upcoming
                if (mostRecentPast) {
                    activeEvent = { time: mostRecentPast.timeSeconds, event: mostRecentPast };
                    console.log(`GPIO${gpio} using most recent past event:`, mostRecentPast.time, mostRecentPast.pwm_value);
                } else if (nextUpcoming) {
                    activeEvent = { time: nextUpcoming.timeSeconds, event: nextUpcoming };
                    console.log(`GPIO${gpio} using next upcoming event:`, nextUpcoming.time, nextUpcoming.pwm_value);
                }
                
                if (activeEvent) {
                    activeTimeEvents[gpio] = activeEvent;
                }
            });
            
            // Process threshold events for active detection
            const activeThresholdEvents = {};
            thresholdEvents.forEach(event => {
                if (event.last_triggered_at) {
                    const lastTriggered = new Date(event.last_triggered_at);
                    const cooldownMs = (event.cooldown_minutes || 5) * 60 * 1000;
                    const timeSinceTriggered = Date.now() - lastTriggered.getTime();
                    // Threshold events only stay active during their cooldown period
                    if (timeSinceTriggered < cooldownMs) {
                        const gpio = event.gpio;
                        const currentPriority = event.priority || 1;
                        const activePriority = activeThresholdEvents[gpio] ? (activeThresholdEvents[gpio].event.priority || 1) : 999;
                        
                        if (!activeThresholdEvents[gpio] || currentPriority < activePriority) {
                            activeThresholdEvents[gpio] = { event: event };
                        }
                    }
                }
            });
            
            // Determine final active events by combining time and threshold events with priority
            const finalActiveEvents = {};
            
            // First, add all active time events
            Object.keys(activeTimeEvents).forEach(gpio => {
                finalActiveEvents[gpio] = activeTimeEvents[gpio];
            });
            
            // Then, override with threshold events if they have higher priority
            Object.keys(activeThresholdEvents).forEach(gpio => {
                const thresholdEvent = activeThresholdEvents[gpio];
                const timeEvent = finalActiveEvents[gpio];
                
                if (!timeEvent) {
                    // No time event, use threshold event
                    finalActiveEvents[gpio] = thresholdEvent;
                } else {
                    // Compare priorities (lower number = higher priority)
                    const thresholdPriority = thresholdEvent.event.priority || 1;
                    const timePriority = timeEvent.event.priority || 1;
                    
                    if (thresholdPriority < timePriority) {
                        finalActiveEvents[gpio] = thresholdEvent;
                    }
                    // If same priority, threshold events take precedence during their cooldown
                    else if (thresholdPriority === timePriority) {
                        finalActiveEvents[gpio] = thresholdEvent;
                    }
                }
            });

            for (const pinStr of Object.keys(this.pwmPins)) {
                const pin = parseInt(pinStr);
                if (this.pwmPins[pin]) {
                    if (finalActiveEvents[pin]) {
                        const pwmValueDb = finalActiveEvents[pin].event.pwm_value;
                        const hardwareValue = Math.floor((pwmValueDb / 1023) * 255);
                        try {
                            this.pwmPins[pin].pwmWrite(hardwareValue);
                        } catch (e) {
                             console.error(`GpioController: Error auto-setting PWM for GPIO${pin}:`, e.message);
                        }
                        await new Promise((resolve, reject) => {
                            this.configDb.run('UPDATE auto_pwm_states SET value = ?, enabled = 1 WHERE pin = ?',
                                [pwmValueDb, pin], (err) => {
                                    if (err) reject(err); else resolve();
                                });
                        });
                    } else {
                        try {
                            this.pwmPins[pin].pwmWrite(0);
                        } catch(e) {
                             console.error(`GpioController: Error auto-setting PWM for GPIO${pin} to 0:`, e.message);
                        }
                        await new Promise((resolve, reject) => {
                            this.configDb.run('UPDATE auto_pwm_states SET value = 0, enabled = 0 WHERE pin = ?',
                                [pin], (err) => {
                                    if (err) reject(err); else resolve();
                                });
                        });
                    }
                }
            }
        } else { // Manual mode
            const manualStates = await new Promise((resolve, reject) => {
                this.configDb.all('SELECT pin, value, enabled FROM manual_pwm_states', [], (err, rows) => {
                    if (err) reject(err);
                    else {
                        const states = rows.reduce((acc, row) => {
                            acc[row.pin] = { value: row.value, enabled: row.enabled };
                            return acc;
                        }, {});
                        resolve(states);
                    }
                });
            });

            for (const [pin, state] of Object.entries(manualStates)) {
                if (this.pwmPins[pin]) {
                    if (state.enabled) {
                        const hardwareValue = Math.floor((state.value / 1023) * 255);
                        try {
                            this.pwmPins[pin].pwmWrite(hardwareValue);
                        } catch (e) {
                            console.error(`GpioController: Error manual-setting PWM for GPIO${pin}:`, e.message);
                        }
                    } else {
                         try {
                            this.pwmPins[pin].pwmWrite(0);
                        } catch (e) {
                            console.error(`GpioController: Error manual-setting PWM for GPIO${pin} to 0:`, e.message);
                        }
                    }
                }
            }
        }
    }

    emergencyStopOutputs() {
        if (!this.pwmEnabled) return;
        console.log('GpioController: Activating emergency stop for PWM outputs.');
        for (const pin of Object.keys(this.pwmPins)) {
            if (this.pwmPins[pin]) {
                try {
                    this.pwmPins[pin].pwmWrite(0);
                } catch (e) {
                    console.error(`GpioController: Error setting GPIO${pin} to 0 during E-Stop:`, e.message);
                }
            }
        }
    }

    async clearEmergencyStopOutputs() {
        if (!this.pwmEnabled) return;
        console.log('GpioController: Clearing emergency stop, re-applying PWM states from DB.');
        // Re-apply PWM states based on current mode and DB values
        await this.applyPwmStatesFromDb();
    }

    async getPwmStatesForStatus() {
        return new Promise((resolve, reject) => {
            this.configDb.all('SELECT pin, value, enabled FROM manual_pwm_states', [], (err, rows) => {
                if (err) {
                    console.error('GpioController: Error fetching PWM states for status:', err);
                    reject(err);
                    return;
                }
                const states = {};
                rows.forEach(row => {
                    states[row.pin] = {
                        value: row.value,
                        enabled: row.enabled === 1
                    };
                });
                resolve(states);
            });
        });
    }
}

module.exports = GpioController;