// One image, two roles. PROXY_MODE=1 runs the small egress relay; otherwise the rental watcher.
await import(process.env.PROXY_MODE === "1" ? "./relay-main.js" : "./app-main.js");
