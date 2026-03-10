/**
 * Checks if a string matches the date pattern YYYY-MM-DD-HH-MM.
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isValidDateFolderName(name: string): boolean {
	// Use Date parsing to validate YYYY-MM-DD-HH-MM
	const parts = name.split("-");
	if (parts.length !== 5) return false;
	const [year, month, day, hour, minute] = parts.map(Number);
	if (
		isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)
		|| year < 1000 || year > 9999
		|| month < 1 || month > 12
		|| day < 1 || day > 31
		|| hour < 0 || hour > 23
		|| minute < 0 || minute > 59
	) {
		return false;
	}
	// Construct a Date object and check if it matches
	const date = new Date(year, month - 1, day, hour, minute);
	return (
		date.getFullYear() === year &&
		date.getMonth() === month - 1 &&
		date.getDate() === day &&
		date.getHours() === hour &&
		date.getMinutes() === minute
	);
}
/**
 * Checks if a string matches the version pattern v01, v02, etc.
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isVersionFolderName(name: string): boolean {
	return /^v\d{2}$/.test(name);
}
/**
 * Checks if a string matches the timestamp pattern YYYYMMDDHHMMSS (14 digits).
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isTimestampFolderName(name: string): boolean {
	return /^\d{14}$/.test(name);
}
