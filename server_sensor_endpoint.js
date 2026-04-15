/**
 * CAMERA SENSOR DATA SUBMISSION ENDPOINT
 * 
 * Add this to your server.js file to handle real sensor data uploads
 * This endpoint accepts image data from cameras or other sensors and stores them
 */

const fs = require('fs');
const path = require('path');

// ========== HELPER FUNCTION: Ensure upload directory exists ==========
const ensureUploadDir = () => {
  const uploadDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
};

// ========== HELPER FUNCTION: Validate image data ==========
const validateImageData = (imageData) => {
  // Check if it's base64
  if (typeof imageData !== 'string') return false;
  
  // Check size (max 5MB)
  const sizeInBytes = Buffer.byteLength(imageData, 'base64');
  if (sizeInBytes > 5 * 1024 * 1024) return false;
  
  // Check if it looks like valid base64
  try {
    Buffer.from(imageData, 'base64');
    return true;
  } catch (e) {
    return false;
  }
};

// ========== MAIN ENDPOINT: Submit Real Sensor Data ==========
/**
 * POST /api/sensor-data/submit
 * 
 * Accepts real sensor data from cameras or other IoT devices
 * 
 * Request body:
 * {
 *   "device_id": "camera_001",
 *   "image_data": "base64_encoded_image_or_null",
 *   "image_url": "https://external-url/image.jpg (optional)",
 *   "metadata": {
 *     "timestamp": "2024-04-15T14:30:00Z",
 *     "sensor_type": "camera",
 *     "resolution": "1920x1080",
 *     "brightness": 128,
 *     "motion_detected": false,
 *     "temperature": 22.5,
 *     "humidity": 45,
 *     "custom_field": "any value"
 *   }
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Sensor data recorded successfully",
 *   "data_id": 12345
 * }
 */
app.post('/api/sensor-data/submit', authenticateToken, async (req, res) => {
  try {
    const { device_id, image_data, image_url, metadata } = req.body;

    // Validation: device_id required
    if (!device_id || typeof device_id !== 'string') {
      return res.status(400).json({ error: 'device_id is required and must be a string' });
    }

    // Validation: must have either image_data or image_url
    if (!image_data && !image_url) {
      return res.status(400).json({ error: 'Either image_data or image_url must be provided' });
    }

    // Validation: if image_data provided, validate it
    if (image_data && !validateImageData(image_data)) {
      return res.status(400).json({ error: 'Invalid image data format or size exceeds 5MB' });
    }

    // Verify device belongs to this user
    db.get(
      'SELECT * FROM devices WHERE device_id = ? AND user_id = ?',
      [device_id, req.user.id],
      (err, device) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }
        if (!device) {
          return res.status(403).json({ error: 'Device not found or access denied' });
        }

        // Prepare metadata as JSON string
        let metadataStr = '{}';
        if (metadata && typeof metadata === 'object') {
          metadataStr = JSON.stringify(metadata);
        }

        // Handle image file storage if image_data provided
        let imagePath = null;
        if (image_data) {
          try {
            // Create directory for this device's images
            const uploadDir = ensureUploadDir();
            const deviceDir = path.join(uploadDir, `device_${device_id}`);
            if (!fs.existsSync(deviceDir)) {
              fs.mkdirSync(deviceDir, { recursive: true });
            }

            // Generate filename with timestamp
            const timestamp = Date.now();
            const imageName = `${timestamp}.jpg`;
            const imagePath = path.join(deviceDir, imageName);

            // Decode base64 and save to disk
            const imageBuffer = Buffer.from(image_data, 'base64');
            fs.writeFileSync(imagePath, imageBuffer);

            // Store relative path for serving via HTTP
            imagePath = `/uploads/device_${device_id}/${imageName}`;
          } catch (err) {
            console.error('Error saving image:', err);
            return res.status(500).json({ error: 'Failed to save image' });
          }
        }

        // Insert sensor data into database
        db.run(
          `INSERT INTO sensor_data 
           (device_id, image_url, image_data, metadata, timestamp) 
           VALUES (?, ?, ?, ?, datetime('now'))`,
          [device_id, image_url || imagePath, image_data ? 'stored_on_disk' : null, metadataStr],
          function(insErr) {
            if (insErr) {
              console.error('Error inserting sensor data:', insErr);
              return res.status(500).json({ error: 'Failed to store sensor data' });
            }

            // Update device's last_seen_at timestamp
            db.run(
              'UPDATE devices SET last_seen_at = datetime(?), status = ? WHERE device_id = ?',
              [new Date().toISOString(), 'online', device_id]
            );

            res.json({
              success: true,
              message: 'Sensor data recorded successfully',
              data_id: this.lastID,
              image_url: imagePath || image_url
            });
          }
        );
      }
    );
  } catch (err) {
    console.error('Unexpected error in sensor-data/submit:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ENDPOINT: Get Latest Sensor Image ==========
/**
 * GET /api/sensor-data/:deviceId/latest-image
 * 
 * Returns the most recent image captured from a device
 */
app.get('/api/sensor-data/:deviceId/latest-image', authenticateToken, (req, res) => {
  const { deviceId } = req.params;

  db.get(
    'SELECT * FROM devices WHERE device_id = ? AND user_id = ?',
    [deviceId, req.user.id],
    (err, device) => {
      if (err || !device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      db.get(
        'SELECT image_url, metadata, timestamp FROM sensor_data WHERE device_id = ? ORDER BY timestamp DESC LIMIT 1',
        [deviceId],
        (err, data) => {
          if (err || !data) {
            return res.status(404).json({ error: 'No images found' });
          }

          res.json({
            image_url: data.image_url,
            timestamp: data.timestamp,
            metadata: data.metadata ? JSON.parse(data.metadata) : {}
          });
        }
      );
    }
  );
});

// ========== ENDPOINT: Get Sensor Image History (Thumbnails) ==========
/**
 * GET /api/sensor-data/:deviceId/image-history?limit=20&offset=0
 * 
 * Returns list of recent images with timestamps for thumbnail gallery
 */
app.get('/api/sensor-data/:deviceId/image-history', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  db.get(
    'SELECT * FROM devices WHERE device_id = ? AND user_id = ?',
    [deviceId, req.user.id],
    (err, device) => {
      if (err || !device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      db.all(
        'SELECT id, image_url, timestamp, metadata FROM sensor_data WHERE device_id = ? AND image_url IS NOT NULL ORDER BY timestamp DESC LIMIT ? OFFSET ?',
        [deviceId, limit, offset],
        (err, images) => {
          if (err) {
            return res.status(500).json({ error: 'Error fetching images' });
          }

          res.json({
            images: images.map(img => ({
              id: img.id,
              url: img.image_url,
              timestamp: img.timestamp,
              metadata: img.metadata ? JSON.parse(img.metadata) : {}
            }))
          });
        }
      );
    }
  );
});

// ========== MIDDLEWARE: Serve uploaded images (add to server.js after middleware setup) ==========
// This allows serving images stored in the public/uploads directory
// app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
