// Keep composition independent of requestAnimationFrame, which stops in hidden tabs.
// OS sleep and browser suspension still require an explicit warning to the presenter.
setInterval(() => postMessage(null), 40);
export {};
