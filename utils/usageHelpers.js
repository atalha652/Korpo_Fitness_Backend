/**
 * Usage Tracking Helper Functions
 * Functions for calculating dates, formatting usage records, etc.
 */

/**
 * Get current month in YYYY-MM format (UTC)
 * @returns {string} Current month (e.g., "2025-01")
 */
export function getCurrentMonth() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get today's date in YYYY-MM-DD format (UTC)
 * @returns {string} Today's date (e.g., "2025-01-21")
 */
export function getTodayDate() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
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
 * Extract month from ISO timestamp (YYYY-MM-DD or full ISO string) (UTC)
 * @param {string} isoTimestamp - ISO format timestamp
 * @returns {string} Month in YYYY-MM format
 */
export function extractMonthFromTimestamp(isoTimestamp) {
  try {
    const date = new Date(isoTimestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  } catch (error) {
    return getCurrentMonth();
  }
}

/**
 * Get the next daily reset time (12:00 AM UTC)
 * @returns {Date} Next reset time
 */
export function getNextDailyReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0); // Set to 12:00 AM UTC
  return tomorrow;
}

/**
 * Get time remaining until next daily reset
 * @returns {Object} { hours, minutes, seconds, totalMs }
 */
export function getTimeUntilReset() {
  const now = new Date();
  const nextReset = getNextDailyReset();
  const diffMs = nextReset.getTime() - now.getTime();
  
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
  
  return {
    hours,
    minutes,
    seconds,
    totalMs: diffMs,
    resetTime: nextReset.toISOString()
  };
}

/**
 * Check if it's a new day compared to a given timestamp
 * @param {string} lastTimestamp - ISO timestamp to compare
 * @returns {boolean} True if it's a new day (UTC)
 */
export function isNewDay(lastTimestamp) {
  if (!lastTimestamp) return true;
  
  try {
    const lastDate = new Date(lastTimestamp);
    const today = getTodayDate();
    const lastDay = `${lastDate.getUTCFullYear()}-${String(lastDate.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDate.getUTCDate()).padStart(2, '0')}`;
    
    return today !== lastDay;
  } catch (error) {
    return true;
  }
}
