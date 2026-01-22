/**
 * Usage Tracking Helper Functions
 * Functions for calculating dates, formatting usage records, etc.
 */

/**
 * Get current month in YYYY-MM format
 * @returns {string} Current month (e.g., "2025-01")
 */
export function getCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string} Today's date (e.g., "2025-01-21")
 */
export function getTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validate if a timestamp is newer than another timestamp
 * Used to prevent duplicate usage reports
 * 
 * @param {string} newTimestamp - ISO string of new timestamp
 * @param {string|null} lastTimestamp - ISO string of last reported timestamp
 * @returns {boolean} True if newTimestamp is newer
 */
export function isTimestampNewer(newTimestamp, lastTimestamp) {
  if (!lastTimestamp) return true; // No previous timestamp, allow
  
  try {
    const newTime = new Date(newTimestamp).getTime();
    const lastTime = new Date(lastTimestamp).getTime();
    return newTime > lastTime;
  } catch (error) {
    return false;
  }
}

/**
 * Extract month from ISO timestamp (YYYY-MM-DD or full ISO string)
 * @param {string} isoTimestamp - ISO format timestamp
 * @returns {string} Month in YYYY-MM format
 */
export function extractMonthFromTimestamp(isoTimestamp) {
  try {
    const date = new Date(isoTimestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  } catch (error) {
    return getCurrentMonth();
  }
}
