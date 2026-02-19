export function step(msg) {
  console.log(`\n=== ${msg} ===`);
}
export function info(msg) {
  console.log(msg);
}
export function error(msg) {
  console.error("❌", msg);
}
