/** Text size steps, smallest to largest, as each platform names them. "Default" is each one's own. */
export const TEXT_SIZES = [
  { label: "Smallest", ios: "extra-small", android: 0.85 },
  { label: "Smaller", ios: "small", android: 0.9 },
  { label: "Small", ios: "medium", android: 0.95 },
  { label: "Default", ios: "large", android: 1 },
  { label: "Large", ios: "extra-large", android: 1.15 },
  { label: "Larger", ios: "extra-extra-large", android: 1.3 },
  { label: "Largest", ios: "extra-extra-extra-large", android: 1.5 },
] as const;

/** The step for what a device reports: an iOS category, or Android's font scale (the nearest). */
export function textSizeIndex(platform: "ios" | "android", value: string): number | null {
  if (platform === "ios") {
    const index = TEXT_SIZES.findIndex((size) => size.ios === value.trim());
    return index < 0 ? null : index;
  }
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  let best = 0;
  TEXT_SIZES.forEach((size, i) => {
    if (Math.abs(size.android - scale) < Math.abs(TEXT_SIZES[best].android - scale)) best = i;
  });
  return best;
}

/**
 * App permissions a tester flips most, per platform: simctl's privacy services on iOS (no camera
 * or notifications there), runtime permissions on Android.
 */
export const PERMISSIONS = {
  location: {
    label: "Location",
    ios: "location",
    android: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
  },
  camera: { label: "Camera", ios: null, android: ["android.permission.CAMERA"] },
  microphone: { label: "Microphone", ios: "microphone", android: ["android.permission.RECORD_AUDIO"] },
  photos: { label: "Photos", ios: "photos", android: ["android.permission.READ_MEDIA_IMAGES"] },
  contacts: { label: "Contacts", ios: "contacts", android: ["android.permission.READ_CONTACTS"] },
  calendar: { label: "Calendar", ios: "calendar", android: ["android.permission.READ_CALENDAR"] },
  notifications: { label: "Notifications", ios: null, android: ["android.permission.POST_NOTIFICATIONS"] },
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

export const LOCATIONS = [
  { label: "Cupertino", lat: 37.3349, lon: -122.009 },
  { label: "London", lat: 51.5072, lon: -0.1276 },
  { label: "Berlin", lat: 52.52, lon: 13.405 },
  { label: "Tokyo", lat: 35.6762, lon: 139.6503 },
  { label: "Sydney", lat: -33.8688, lon: 151.2093 },
] as const;

/** "52.52, 13.405" (or with a space instead of the comma) as a point, or null. */
export function parseLocation(text: string): { lat: number; lon: number } | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/**
 * An app's id as the device reports it (a test runner's can be just ".xctrunner"). It goes to simctl
 * and adb as one argument, quoted for a device shell: it only mustn't pass for an option.
 */
export const APP_ID = /^[^\s-]\S{0,254}$/;

type ListedApp = { ApplicationType?: string; CFBundleDisplayName?: string; CFBundleName?: string };

/**
 * The apps a tester sets permissions for, from `simctl listapps`: installed by the user, but not
 * an XCTest runner (agent-device's, or a project's UI tests), nor an id an action couldn't take.
 */
export function userApps(apps: Record<string, ListedApp>) {
  return Object.entries(apps)
    .filter(([id, app]) => app.ApplicationType === "User" && !id.endsWith(".xctrunner") && APP_ID.test(id))
    .map(([id, app]) => ({ id, name: app.CFBundleDisplayName ?? app.CFBundleName ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
