// Process node status updates
if (packet.topic.match(/^undergrowth\/nodes\/([^\/]+)\/status$/)) {
    try {
        const nodeId = packet.topic.split('/')[2];
        const payload = JSON.parse(packet.payload.toString());
        
        // Debug logging
        logger.info('Received node status update:', {
            nodeId,
            hostname: payload.hostname,
            ip: payload.ip,
            clientId: client.id
        });
        
        // Update hostname and IP if available
        if (payload.hostname || payload.ip) {
            configDb.run(
                'UPDATE connected_nodes SET hostname = ?, ip_address = ? WHERE id = ?',
                [payload.hostname, payload.ip, client.id],
                (err) => {
                    if (err) {
                        logger.error('Error updating node info:', err);
                    } else {
                        logger.info('Updated node info:', {
                            nodeId: client.id,
                            hostname: payload.hostname,
                            ip: payload.ip
                        });
                    }
                }
            );
        }
        
        // Update last_seen in nodes table
        configDb.run(
            'INSERT OR REPLACE INTO nodes (id, last_seen) VALUES (?, ?)',
            [nodeId, new Date().toISOString()]
        );
        
    } catch (error) {
        logger.error('Error processing node status:', error);
    }
} 