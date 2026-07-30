// Create PocketBase client instance using local PocketBase package
import PocketBase from 'pocketbase';
import type { TypedPocketBase } from './types';

export interface PocketBaseClientOptions {
  enableAutoCancellation?: boolean;
  requestTimeout?: number;
}

/**
 * Create a configured PocketBase client with proper settings
 */
function createPocketBaseClient(
  url: string = 'http://localhost:8090',
  options: PocketBaseClientOptions = {}
): TypedPocketBase {
  const pb = new PocketBase(url) as TypedPocketBase;

  // Enable auto cancellation for duplicate requests
  pb.autoCancellation(options.enableAutoCancellation ?? false);

  // Add global error interceptor for better error handling
  pb.beforeSend = function (url, requestOptions) {
    // Add timeout to prevent hanging requests
    if (!requestOptions.signal && options.requestTimeout) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), options.requestTimeout);
      requestOptions.signal = controller.signal;
    }

    return { url, options: requestOptions };
  };

  return pb;
}

// Create PocketBase client instance
const pb = createPocketBaseClient(
  process.env.NEXT_PUBLIC_POCKETBASE_URL || 'http://localhost:8090',
  {
    enableAutoCancellation: false,
    requestTimeout: 30000, // 30 second timeout
  }
);

// Export the client instance
export default pb;
