import { getCommutePreferences, setCommuteNotifications } from './commutePreferences';

export const notificationState = () => ({
  supported: typeof window !== 'undefined' && 'Notification' in window,
  permission: typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  enabled: getCommutePreferences().notifications,
});

export const enableDisruptionNotifications = async () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return notificationState();
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  const enabled = permission === 'granted';
  setCommuteNotifications(enabled);
  return { supported: true, permission, enabled };
};

export const disableDisruptionNotifications = () => {
  setCommuteNotifications(false);
  return notificationState();
};

export const notifyDisruption = async (alert) => {
  if (!alert || !notificationState().enabled || typeof window === 'undefined') return false;
  const title = `Vienna Rail · ${alert.title || 'Service update'}`;
  const body = [alert.lines?.join(' · '), alert.description || alert.reason].filter(Boolean).join(' — ').slice(0, 220);
  const options = { body: body || 'Check the live map for details.', icon: './icons/pwa-192.svg', tag: `vienna-disruption-${alert.id || alert.title}` };
  try {
    if (navigator.serviceWorker?.ready) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
    } else new Notification(title, options);
    return true;
  } catch {
    return false;
  }
};
