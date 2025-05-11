#!/bin/bash
# Automation_Custom_Script.sh for undergrowth-node
# This script runs after first boot and performs all custom installation tasks

# ======================================
# Create detailed installation log & boot verification logs
# ======================================
INSTALL_LOG="/boot/install_log.txt"
exec > >(tee -a $INSTALL_LOG) 2>&1

echo "==========================================="
echo "Starting undergrowth-node installation at $(date)" 
echo "==========================================="

# Create verification directory for final status
mkdir -p /boot/verification_logs

# ======================================
# Power optimization during installation
# ======================================
echo "Setting CPU governor to performance for installation..."
if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
    echo performance > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
    echo "CPU governor set to performance"
else
    echo "CPU governor control not available"
fi

# Maximize WiFi signal strength for better connectivity during install
echo "Setting WiFi TX power to maximum..."
if command -v iwconfig > /dev/null; then
    iwconfig wlan0 txpower 31 || echo "Failed to set txpower"
    echo "Disabling WiFi power management..."
    if ! grep -q "8192cu" /etc/modprobe.d/8192cu.conf 2>/dev/null; then
        echo "options 8192cu rtw_power_mgnt=0 rtw_enusbss=0" > /etc/modprobe.d/8192cu.conf
    fi
    if ! grep -q "brcmfmac" /etc/modprobe.d/wifi-power-management.conf 2>/dev/null; then
        echo "options brcmfmac power_save=0" > /etc/modprobe.d/wifi-power-management.conf
    fi
else
    echo "iwconfig not found, skipping WiFi power settings"
fi

# ======================================
# Hardware Interface Configuration
# ======================================
echo "Enabling I2C interface..."
/boot/dietpi/func/dietpi-set_hardware i2c enable || echo "Failed to enable I2C interface"

# Enable GPIO in config.txt if not already enabled
echo "Enabling GPIO in config.txt..."
if ! grep -q "^dtparam=gpio=on" /boot/config.txt; then
    echo "dtparam=gpio=on" >> /boot/config.txt
    echo "Added GPIO configuration to config.txt"
else
    echo "GPIO already enabled in config.txt"
fi

# Enable SPI in config.txt if not already enabled
echo "Enabling SPI in config.txt..."
if ! grep -q "^dtparam=spi=on" /boot/config.txt; then
    echo "dtparam=spi=on" >> /boot/config.txt
    echo "Added SPI configuration to config.txt"
else
    echo "SPI already enabled in config.txt"
fi

# ======================================
# Network Monitoring Tools
# ======================================
echo "Setting up network diagnostic tools..."

# Create network diagnostic script
cat > /usr/local/bin/network-debug.sh << 'EOF'
#!/bin/bash
LOG="/boot/logs/network-$(date +%Y%m%d-%H%M%S).log"
mkdir -p /boot/logs
echo "=== Network Diagnostics $(date) ===" > $LOG
echo "--- WiFi Interfaces ---" >> $LOG
iwconfig >> $LOG 2>&1
echo "--- IP Configuration ---" >> $LOG
ifconfig >> $LOG 2>&1
echo "--- Routing Table ---" >> $LOG
route -n >> $LOG 2>&1
echo "--- DNS Settings ---" >> $LOG
cat /etc/resolv.conf >> $LOG 2>&1
echo "--- Connection Test ---" >> $LOG
ping -c 4 8.8.8.8 >> $LOG 2>&1
echo "--- Network Services ---" >> $LOG
systemctl status wpa_supplicant >> $LOG 2>&1
EOF
chmod +x /usr/local/bin/network-debug.sh

# Create network diagnostics service
cat > /etc/systemd/system/network-debug.service << 'EOF'
[Unit]
Description=Network Diagnostics Logger
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/network-debug.sh

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable network-debug.service

# Create WiFi connection watchdog
cat > /usr/local/bin/wifi-watchdog.sh << 'EOF'
#!/bin/bash
# Check if we can reach our default gateway
GATEWAY=$(ip route | grep default | head -1 | awk '{print $3}')
if [ -n "$GATEWAY" ] && ! ping -c 1 -W 5 $GATEWAY > /dev/null 2>&1; then
    logger -t wifi-watchdog "Cannot reach gateway $GATEWAY, restarting wlan0"
    echo "$(date): Cannot reach gateway, restarting wlan0" >> /boot/logs/wifi-reconnects.log
    ifconfig wlan0 down
    sleep 5
    ifconfig wlan0 up
    sleep 10
    # Run network diagnostics after reconnect attempt
    /usr/local/bin/network-debug.sh
fi
EOF
chmod +x /usr/local/bin/wifi-watchdog.sh

# Add cron job to check connection every 5 minutes
echo "*/5 * * * * root /usr/local/bin/wifi-watchdog.sh" > /etc/cron.d/wifi-watchdog

# ======================================
# System Optimization
# ======================================
echo "Disabling unused system services..."
systemctl disable triggerhappy 2>/dev/null || true
systemctl disable bluetooth.service 2>/dev/null || true
systemctl disable hciuart.service 2>/dev/null || true
systemctl disable apt-daily.service 2>/dev/null || true
systemctl disable apt-daily.timer 2>/dev/null || true
systemctl disable apt-daily-upgrade.timer 2>/dev/null || true
systemctl disable apt-daily-upgrade.service 2>/dev/null || true

# Configure log2ram
if command -v log2ram &> /dev/null; then
    echo "Configuring log2ram to reduce SD card writes..."
    echo "SIZE=128M" > /etc/log2ram.conf
    echo "MAIL=false" >> /etc/log2ram.conf
    echo "LOGS_RSYNC=false" >> /etc/log2ram.conf
else
    echo "log2ram not installed, skipping configuration"
fi

# ======================================
# Python Dependencies
# ======================================
echo "Installing Python dependencies..."
apt-get update
apt-get install -y python3-distutils python3-dev || echo "Failed to install Python dependencies"

# ======================================
# Pigpio Installation and Configuration
# ======================================
echo "Installing Pigpio C Library..."
cd /tmp
wget https://github.com/joan2937/pigpio/archive/master.zip || { echo "Failed to download pigpio"; exit 1; }
unzip master.zip || { echo "Failed to extract pigpio"; exit 1; }
cd pigpio-master || { echo "Failed to change directory"; exit 1; }

# Modify the Makefile to skip Python installation if needed
# This is optional, but helps if Python setup continues to cause issues
sed -i 's/^PYINSTALL.*/PYINSTALL = :/' Makefile || echo "Failed to modify Makefile"

make || { echo "Failed to compile pigpio"; exit 1; }
make install || { echo "Failed to install pigpio"; exit 1; }

# Manually copy libraries and executables if make install fails
if [ ! -f "/usr/local/bin/pigpiod" ]; then
    echo "Manual installation of pigpio..."
    cp libpigpio.so* /usr/local/lib/ || echo "Failed to copy libpigpio.so"
    cp pigpiod /usr/local/bin/ || echo "Failed to copy pigpiod"
    cp pigs /usr/local/bin/ || echo "Failed to copy pigs"
    ldconfig || echo "Failed to run ldconfig"
fi

# Create socket directory for pigpio
echo "Creating socket directory for pigpio..."
mkdir -p /var/run/pigpio

# Start pigpio daemon with updated service definition
systemctl stop pigpiod 2>/dev/null || echo "No existing pigpiod service to stop"
echo "Creating pigpiod service..."
cat > /etc/systemd/system/pigpiod.service << EOL
[Unit]
Description=Pigpio daemon
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/bin/pigpiod -l
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOL
systemctl daemon-reload
systemctl enable pigpiod || echo "Failed to enable pigpiod service"
systemctl start pigpiod || echo "Failed to start pigpiod service"

# Test pigpio socket connection
echo "Testing pigpio socket connection..."
sleep 2
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio socket connection failed. Will retry after completing setup."
fi

# ======================================
# Node.js Installation
# ======================================
echo "Installing NVM..."
export NVM_DIR="/root/.nvm"
mkdir -p "$NVM_DIR"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash || { echo "Failed to install NVM"; exit 1; }
# Source NVM for this session
export NVM_DIR="/root/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

# Install Node.js
echo "Installing Node.js..."
command -v nvm || { echo "NVM not installed properly"; exit 1; }
nvm install --lts || { echo "Failed to install Node.js"; exit 1; }
nvm use --lts || { echo "Failed to use LTS Node.js"; exit 1; }
NODE_VERSION=$(nvm current)
nvm alias default "$NODE_VERSION" || echo "Failed to set default Node.js version"

# Add NVM to root profile
echo 'export NVM_DIR="/root/.nvm"' >> /root/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm' >> /root/.bashrc
echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion' >> /root/.bashrc

# ======================================
# Undergrowth Node Project Setup
# ======================================
echo "Cloning undergrowth-node repository..."
mkdir -p /root/git
cd /root/git || { echo "Failed to create git directory"; exit 1; }
git clone https://github.com/colepurbaugh/undergrowth-node.git || { echo "Failed to clone repository"; exit 1; }
cd undergrowth-node || { echo "Failed to change directory"; exit 1; }

# Install npm dependencies
echo "Installing npm dependencies..."
npm install || { echo "Failed to install npm dependencies"; exit 1; }

# Create database directory if it doesn't exist
mkdir -p database

# Get actual Node.js path - double check to make sure it exists
NODE_PATH=$(which node)
if [ ! -f "$NODE_PATH" ]; then
    echo "Node.js executable not found via 'which'. Using direct path."
    NODE_PATH="/root/.nvm/versions/node/$(ls -t /root/.nvm/versions/node/ | head -1)/bin/node"
fi
echo "Using Node.js at: $NODE_PATH"

# ======================================
# Service Configuration
# ======================================
echo "Setting up systemd service..."
cat > /etc/systemd/system/ug-node.service << EOL
[Unit]
Description=Undergrowth Node.js Server
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=500
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=/root/git/undergrowth-node
ExecStartPre=/bin/sleep 15
ExecStartPre=/bin/systemctl stop pigpiod.service
ExecStart=${NODE_PATH} ug-node.js
ExecStopPost=/bin/systemctl start pigpiod.service
Environment=NODE_ENV=production
Environment=PATH=/root/.nvm/versions/node/$(ls -t /root/.nvm/versions/node/ | head -1)/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ug-node

[Install]
WantedBy=multi-user.target
EOL

# Make node.js able to bind to port 80
echo "Setting capabilities for Node.js..."
setcap 'cap_net_bind_service=+ep' "$NODE_PATH" || echo "Failed to set capabilities"

# Add user to necessary groups
echo "Adding user to required groups..."
usermod -a -G gpio,i2c,spi,kmem root || echo "Failed to add user to groups"

# ======================================
# Post-Installation Power & Performance Settings
# ======================================
echo "Reducing overvoltage after installation for long-term stability..."
sed -i 's/over_voltage=4/over_voltage=2/' /boot/config.txt

echo "Adjusting arm_freq for better performance after installation..."
sed -i 's/arm_freq=900/arm_freq=1000/' /boot/config.txt

# Set CPU back to normal governor
if [ -f /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]; then
    echo "Reverting CPU governor to ondemand for normal operation..."
    echo ondemand > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
fi

# ======================================
# Hardware Watchdog Setup
# ======================================
if command -v watchdog > /dev/null; then
    echo "Setting up hardware watchdog..."
    cat > /etc/watchdog.conf << EOF
watchdog-device = /dev/watchdog
watchdog-timeout = 15
max-load-1 = 24
interval = 10
EOF
    systemctl enable watchdog
    systemctl start watchdog
else
    echo "Watchdog package not installed. Skipping watchdog configuration."
fi

# ======================================
# Enable and Start Services
# ======================================
echo "Enabling and starting ug-node service..."
systemctl daemon-reload
systemctl enable ug-node
systemctl start ug-node

# Make boot partition read-only after setup
echo "Setting boot partition to read-only to protect configuration files..."
if grep -q "/boot vfat" /etc/fstab; then
    sed -i 's/\/boot vfat defaults/\/boot vfat ro,defaults/' /etc/fstab
fi

# ======================================
# Final Tests and Verification
# ======================================
# Final pigpio test to verify it's working
echo "Final pigpio test..."
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio still not working, manual troubleshooting may be needed."
    echo "Try running: systemctl restart pigpiod"
    echo "Then test with: pigs r 0"
fi

# Run network diagnostics
echo "Running network diagnostics..."
/usr/local/bin/network-debug.sh

echo "Installation completed at $(date)"

# ======================================
# Final verification step - Wait and Check Service Status
# ======================================
echo "Waiting 2 minutes for services to stabilize before final verification..."
sleep 120

# Check if service is running correctly
if systemctl is-active --quiet ug-node; then
    # Success case
    echo "SUCCESS: ug-node service is running properly!" > /boot/verification_logs/INSTALLATION_SUCCESS.log
    echo "Installation completed at: $(date)" >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    echo "System information:" >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    uname -a >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    uptime >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    free -m >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    df -h >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    iwconfig >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    ifconfig >> /boot/verification_logs/INSTALLATION_SUCCESS.log
    
    echo "INSTALLATION SUCCESSFUL!" > /boot/INSTALL_STATUS.txt
else
    # Failure case - collect all relevant logs
    echo "ERROR: ug-node service failed to start properly!" > /boot/verification_logs/INSTALLATION_FAILED.log
    echo "Installation failed at: $(date)" >> /boot/verification_logs/INSTALLATION_FAILED.log
    
    # Collect service status and logs
    echo "=== SERVICE STATUS ===" >> /boot/verification_logs/INSTALLATION_FAILED.log
    systemctl status ug-node >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    
    echo "=== SERVICE LOGS ===" >> /boot/verification_logs/INSTALLATION_FAILED.log
    journalctl -u ug-node -n 200 --no-pager >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    
    echo "=== SYSTEM LOGS ===" >> /boot/verification_logs/INSTALLATION_FAILED.log
    journalctl -b -n 500 --no-pager >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    
    echo "=== NETWORK STATUS ===" >> /boot/verification_logs/INSTALLATION_FAILED.log
    iwconfig >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    ifconfig >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    ping -c 4 8.8.8.8 >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    
    echo "=== HARDWARE STATUS ===" >> /boot/verification_logs/INSTALLATION_FAILED.log
    vcgencmd measure_temp >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    vcgencmd get_throttled >> /boot/verification_logs/INSTALLATION_FAILED.log 2>&1
    
    # Copy log files
    cp /var/log/syslog /boot/verification_logs/syslog.txt 2>/dev/null
    cp /var/log/daemon.log /boot/verification_logs/daemon.log 2>/dev/null
    
    # Add troubleshooting information
    echo "Please check these logs to diagnose why the ug-node service failed to start." >> /boot/verification_logs/INSTALLATION_FAILED.log
    echo "Common issues:" >> /boot/verification_logs/INSTALLATION_FAILED.log
    echo "1. WiFi connectivity problems" >> /boot/verification_logs/INSTALLATION_FAILED.log
    echo "2. Power/undervoltage issues" >> /boot/verification_logs/INSTALLATION_FAILED.log
    echo "3. Node.js installation errors" >> /boot/verification_logs/INSTALLATION_FAILED.log
    echo "4. I2C/GPIO permission problems" >> /boot/verification_logs/INSTALLATION_FAILED.log
    
    echo "INSTALLATION FAILED - Check /boot/verification_logs/" > /boot/INSTALL_STATUS.txt
fi

echo "Final verification completed." 