import { reactive, readonly } from 'vue';
import userSettings from '../services/userSettings';

const state = reactive({
  monitorBulkUploads: !!userSettings.get('monitorBulkUploads'),
});

if (typeof userSettings.onChange === 'function') {
  userSettings.onChange((newSettings) => {
    state.monitorBulkUploads = !!(newSettings && newSettings.monitorBulkUploads);
  });
}

function setMonitorBulkUploads(value) {
  const v = !!value;
  userSettings.set('monitorBulkUploads', v);
  state.monitorBulkUploads = v;
}

export function useUserSettings() {
  return {
    settings: readonly(state),
    setMonitorBulkUploads,
  };
}
