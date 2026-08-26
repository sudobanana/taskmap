import TaskMapApp from "@/components/TaskMapApp";
import { CloudSyncProvider } from "@/components/CloudSyncProvider";

export default function Page() {
  return <CloudSyncProvider><TaskMapApp /></CloudSyncProvider>;
}
