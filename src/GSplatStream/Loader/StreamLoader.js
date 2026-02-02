/**
 * Stream loader for progressive resource loading
 * Supports streaming data as it arrives, enabling progressive rendering
 */

export class StreamLoader {
    /**
     * Load resource with streaming support
     * @param {string} url Resource URL
     * @param {Function} parserClass Parser class constructor
     * @param {Object} options Optional loader options
     * @param {Function} options.onProgress Progress callback (receivedLength, contentLength, url, parser)
     * @param {Function} options.onComplete Complete callback (url)
     * @param {Function} options.onError Error callback (error)
     * @returns {Promise<{parser: *, cancel: Function}>} Promise that resolves when initial data is ready
     */
    async loadStream(url, parserClass, options = {}) {
      return new Promise(async (resolve, reject) => {
        let aborted = false;
        let reader = null;
        let abortController = null;

        const cancel = () => {
          aborted = true;
          if (reader) {
            reader.cancel().catch(() => {
              // Ignore cancel errors
            });
            reader.releaseLock();
          }
          if (abortController) {
            abortController.abort();
          }
          if (parser && typeof parser.cancel === 'function') {
            parser.cancel();
          }
        };

        let parser = null;

        try {
          abortController = new AbortController();

          const response = await fetch(url, {
            signal: abortController.signal
          });
          if (!response.ok) {
            throw new Error(`Request rejected with status ${response.status}`);
          }

          reader = response.body.getReader();
          const contentLength = +response.headers.get("Content-Length") || 0;

          if (typeof parserClass === 'function') {
            parser = new parserClass();
          } else {
            parser = parserClass;
          }

          if (typeof parser.initStream !== 'function') {
            const parserName = parserClass?.name || parser?.constructor?.name || 'Unknown';
            throw new Error(`Parser ${parserName} does not support streaming. Implement initStream() method.`);
          }

          let parserResolved = false;

          await parser.initStream(contentLength, () => {
            if (!parserResolved && !aborted && parser && parser.verification()) {
              parserResolved = true;
              resolve({ parser, cancel });
            }
          });

          let receivedLength = 0;

          while (!aborted) {
            const { done, value } = await reader.read();
            if (done || aborted) {
              if (!aborted) {
                if (typeof parser.finalizeStream === 'function') {
                  await parser.finalizeStream();
                }
                if (!parserResolved && parser) {
                  if (parser.verification()) {
                    parserResolved = true;
                    resolve({ parser, cancel });
                  } else {
                    throw new Error("Parser verification failed");
                  }
                }
              }
              break;
            }

            if (aborted) break;

            receivedLength += value.length;

            if (contentLength > 0 && options.onProgress && !aborted) {
              options.onProgress(receivedLength, contentLength, url, parser);
            }

            if (!aborted && typeof parser.processChunk === 'function') {
              await parser.processChunk(value, receivedLength, contentLength);
            }

            if (!parserResolved && !aborted && parser && parser.verification()) {
              parserResolved = true;
              resolve({ parser, cancel });
            }
          }

          if (!aborted && options.onComplete) {
            options.onComplete(url);
          }
        } catch (e) {
          if (aborted) {
            return;
          }
          if (options.onError) {
            options.onError(e);
          }
          reject(e);
        } finally {
          if (reader && !aborted) {
            try {
              reader.releaseLock();
            } catch {
            }
          }
        }
      });
    }
  }


