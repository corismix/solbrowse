export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  wait = 300
): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  
  return (...args: Parameters<T>): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
