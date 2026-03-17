import { Octagon } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useAutonomyStore } from '../../stores/autonomyStore';

export function EmergencyStopButton() {
  const { autonomyEnabled } = useAppStore();

  if (!autonomyEnabled) return null;

  const handleEmergencyStop = async () => {
    // Hard stop — immediate kill, not soft shutdown
    const { emergencyStop } = useAutonomyStore.getState();
    await emergencyStop();
    console.log('[Autonomy] Emergency hard stop triggered');
  };

  return (
    <button
      onClick={handleEmergencyStop}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg shadow-red-900/50 font-medium transition-all hover:scale-105 active:scale-95"
      title="Emergency Stop - Click to immediately stop all autonomous work"
      aria-label="Emergency stop - immediately stop all autonomous work"
    >
      <Octagon className="w-5 h-5" />
      <span>STOP</span>
    </button>
  );
}
