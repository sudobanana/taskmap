"use client";

import { useEffect } from "react";

export default function OfflineBootstrap() {
  useEffect(()=>{
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then(async ()=>{
      if (!("caches" in window)) return;
      const cache = await caches.open("taskmap-runtime-v1");
      const urls = new Set<string>([location.origin + "/"]);
      performance.getEntriesByType("resource").forEach(entry=>{
        if (entry.name.startsWith(location.origin)) urls.add(entry.name);
      });
      await Promise.allSettled([...urls].map(url=>cache.add(url)));
    }).catch(()=>{});
  },[]);
  return null;
}
