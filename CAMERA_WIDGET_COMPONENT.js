/**
 * CAMERA WIDGET COMPONENT
 * 
 * React component to display camera feeds in the device dashboard
 * Add this to your index.html React app (in the device card rendering section)
 */

// ============================================================
// STANDALONE CAMERA WIDGET COMPONENT
// ============================================================

function CameraWidget({ device, token, apiUrl }) {
  const [latestImage, setLatestImage] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [imageHistory, setImageHistory] = React.useState([]);
  const [showHistory, setShowHistory] = React.useState(false);

  // Fetch latest camera image
  const fetchLatestImage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiUrl}/sensor-data/${device.device_id}/latest-image`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (!response.ok) throw new Error('Failed to fetch image');

      const data = await response.json();
      setLatestImage({
        url: data.image_url,
        timestamp: data.timestamp,
        metadata: data.metadata || {}
      });
    } catch (err) {
      setError(err.message);
      console.error('Error fetching camera image:', err);
    } finally {
      setLoading(false);
    }
  }, [device.device_id, token, apiUrl]);

  // Fetch image history gallery
  const fetchImageHistory = React.useCallback(async () => {
    try {
      const response = await fetch(
        `${apiUrl}/sensor-data/${device.device_id}/image-history?limit=12`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      if (!response.ok) throw new Error('Failed to fetch image history');

      const data = await response.json();
      setImageHistory(data.images || []);
    } catch (err) {
      console.error('Error fetching image history:', err);
    }
  }, [device.device_id, token, apiUrl]);

  // Fetch latest image on component mount
  React.useEffect(() => {
    fetchLatestImage();
    // Refresh every 30 seconds
    const interval = setInterval(fetchLatestImage, 30000);
    return () => clearInterval(interval);
  }, [fetchLatestImage]);

  // Check if device is a camera
  if (device.device_type?.toLowerCase() !== 'camera') {
    return null;
  }

  return (
    <div className="camera-widget" style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px solid #eee' }}>
      <h4 style={{ marginBottom: '10px', color: '#333', fontSize: '14px', fontWeight: '600' }}>
        📷 Live Feed
      </h4>

      {/* Latest Image Display */}
      <div style={{ marginBottom: '12px' }}>
        {latestImage ? (
          <div>
            <img
              src={latestImage.url}
              alt="Latest camera frame"
              style={{
                width: '100%',
                borderRadius: '6px',
                maxHeight: '300px',
                objectFit: 'cover',
                marginBottom: '8px',
                backgroundColor: '#f0f0f0'
              }}
            />
            <div style={{ fontSize: '12px', color: '#666' }}>
              <div>
                <strong>Captured:</strong> {new Date(latestImage.timestamp).toLocaleString()}
              </div>
              {latestImage.metadata && (
                <>
                  {latestImage.metadata.resolution && (
                    <div><strong>Resolution:</strong> {latestImage.metadata.resolution}</div>
                  )}
                  {latestImage.metadata.quality && (
                    <div><strong>Quality:</strong> {latestImage.metadata.quality}%</div>
                  )}
                  {latestImage.metadata.motion_detected !== undefined && (
                    <div>
                      <strong>Motion:</strong>{' '}
                      <span style={{ color: latestImage.metadata.motion_detected ? '#dc3545' : '#28a745' }}>
                        {latestImage.metadata.motion_detected ? '🔴 Detected' : '✓ None'}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ) : error ? (
          <div style={{ background: '#f8d7da', color: '#721c24', padding: '10px', borderRadius: '4px', fontSize: '13px' }}>
            ⚠️ {error}
          </div>
        ) : (
          <div style={{ background: '#f0f0f0', padding: '40px 20px', textAlign: 'center', borderRadius: '6px', color: '#999' }}>
            No image available
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <button
          onClick={fetchLatestImage}
          disabled={loading}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '13px',
            fontWeight: '600',
            opacity: loading ? 0.6 : 1
          }}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
        <button
          onClick={() => {
            setShowHistory(!showHistory);
            if (!showHistory && imageHistory.length === 0) {
              fetchImageHistory();
            }
          }}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: '600'
          }}
        >
          {showHistory ? 'Hide' : 'Show'} History
        </button>
      </div>

      {/* Image Gallery/History */}
      {showHistory && (
        <div style={{
          marginTop: '10px',
          padding: '10px',
          background: '#f8f9fa',
          borderRadius: '6px',
          border: '1px solid #ddd'
        }}>
          <h5 style={{ marginBottom: '8px', color: '#333', fontSize: '13px' }}>Recent Frames</h5>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
            gap: '8px'
          }}>
            {imageHistory.length > 0 ? (
              imageHistory.map((image, idx) => (
                <div
                  key={idx}
                  onClick={() => setLatestImage(image)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: '4px',
                    overflow: 'hidden',
                    background: '#f0f0f0',
                    transition: 'transform 0.2s',
                    border: latestImage?.id === image.id ? '2px solid #667eea' : '1px solid #ddd'
                  }}
                  onMouseEnter={(e) => e.target.style.transform = 'scale(1.05)'}
                  onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
                >
                  <img
                    src={image.url}
                    alt={`Frame ${idx}`}
                    style={{
                      width: '100%',
                      paddingBottom: '62.5%',
                      objectFit: 'cover',
                      display: 'block'
                    }}
                  />
                  <div style={{
                    fontSize: '10px',
                    padding: '3px',
                    background: 'rgba(0,0,0,0.6)',
                    color: 'white',
                    textAlign: 'center'
                  }}>
                    {new Date(image.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#999', fontSize: '12px', padding: '20px' }}>
                No images available
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// INTEGRATION EXAMPLE IN DEVICE CARD
// ============================================================

/**
 * How to add the camera widget to your existing device card component:
 * 
 * In your device card rendering section, after the sensor readings display,
 * add this component:
 */

/*
// In your device card component (around line where sensor readings are displayed):

{device.device_type === 'Camera' && (
  <CameraWidget
    device={device}
    token={authToken}  // Your JWT token from state
    apiUrl="/api"      // Your API base URL
  />
)}

// OR to show for all devices:

<CameraWidget
  device={device}
  token={authToken}
  apiUrl="/api"
/>

// The component will return null for non-camera devices
*/

// ============================================================
// FULL DEVICE CARD EXAMPLE WITH CAMERA WIDGET
// ============================================================

/**
 * Complete example showing where to add camera widget in device card:
 */

function DeviceCard({ device, authToken, apiUrl, onDelete, onEdit }) {
  const [sensorData, setSensorData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `${apiUrl}/sensor-data/${device.device_id}?limit=1`,
          { headers: { 'Authorization': `Bearer ${authToken}` } }
        );
        if (response.ok) {
          const data = await response.json();
          setSensorData(data[0]);
        }
      } catch (err) {
        console.error('Error fetching sensor data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [device.device_id, authToken, apiUrl]);

  return (
    <div className="device-card" style={{
      background: 'white',
      borderRadius: '10px',
      padding: '20px',
      boxShadow: '0 4px 15px rgba(0,0,0,0.1)'
    }}>
      {/* Card Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'start',
        marginBottom: '15px'
      }}>
        <div>
          <h3 style={{ color: '#333', marginBottom: '4px' }}>{device.device_name}</h3>
          <p style={{ color: '#666', fontSize: '13px' }}>{device.device_type}</p>
        </div>
        <span style={{
          padding: '4px 10px',
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: '600',
          background: device.status === 'online' ? '#d4edda' : '#f8d7da',
          color: device.status === 'online' ? '#155724' : '#721c24'
        }}>
          {device.status}
        </span>
      </div>

      {/* Sensor Readings (if not camera or has numeric data) */}
      {device.device_type !== 'Camera' && sensorData && (
        <div style={{ marginBottom: '15px', padding: '14px', background: '#f8f9fa', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '7px' }}>
            <span style={{ color: '#666', fontWeight: '500' }}>Temperature:</span>
            <span style={{ color: '#333', fontWeight: '600' }}>{sensorData.temperature}°C</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#666', fontWeight: '500' }}>Humidity:</span>
            <span style={{ color: '#333', fontWeight: '600' }}>{sensorData.humidity}%</span>
          </div>
        </div>
      )}

      {/* CAMERA WIDGET - ADD HERE */}
      <CameraWidget
        device={device}
        token={authToken}
        apiUrl={apiUrl}
      />

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
        <button
          onClick={() => onEdit(device)}
          style={{
            flex: 1,
            padding: '8px',
            background: '#667eea',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '13px'
          }}
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(device.id)}
          style={{
            flex: 1,
            padding: '8px',
            background: '#dc3545',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            fontWeight: '600',
            fontSize: '13px'
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ============================================================
// USAGE NOTES
// ============================================================

/**
 * STYLING:
 * - The component uses inline styles, but you can add CSS classes
 * - Adapt colors to match your existing dashboard theme
 * - Update grid columns for different screen sizes
 * 
 * PROPS:
 * - device: The device object with device_id, device_type, etc
 * - token: JWT authentication token
 * - apiUrl: Base URL for API calls (e.g., '/api')
 * 
 * AUTO-REFRESH:
 * - Latest image refreshes every 30 seconds automatically
 * - Click "Refresh" button for manual refresh
 * - Adjust interval in the useEffect hook
 * 
 * IMAGE HANDLING:
 * - Displays image from image_url returned by API
 * - Falls back to error message if fetch fails
 * - Shows "No image available" if device hasn't captured any
 * 
 * HISTORY GALLERY:
 * - Click "Show History" to see last 12 captured frames
 * - Click any thumbnail to view it in main display
 * - Fetches history on first click (lazy loading)
 */
