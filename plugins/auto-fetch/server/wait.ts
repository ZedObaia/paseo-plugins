/** Waits for work up to `ms`; work that outlasts the wait keeps running. */
export async function wait<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
