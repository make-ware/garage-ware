PocketBase v0.23+ introduced optional Multi-factor authentication (MFA).

If enabled, it requires the user to authenticate with any 2 different auth methods from above (the order doesn't matter).
The expected flow is:

User authenticates with "Auth method A".
On success, a 401 response is sent with {"mfaId": "..."} as JSON body (the MFA "session" is stored in the _mfas system collection).
User authenticates with "Auth method B" as usual but adds the mfaId from the previous step as body or query parameter.
On success, a regular auth response is returned, aka. token + auth record data.
Below is an example for email/password + OTP authentication:

import PocketBase from 'pocketbase';

const pb = new PocketBase('http://127.0.0.1:8090');

...

try {
  await pb.collection('users').authWithPassword('test@example.com', '1234567890');
} catch (err) {
  const mfaId = err.response?.mfaId;
  if (!mfaId) {
    throw err; // not mfa -> rethrow
  }

  // the user needs to authenticate again with another auth method, for example OTP
  const result = await pb.collection('users').requestOTP('test@example.com');
  // ... show a modal for users to check their email and to enter the received code ...
  await pb.collection('users').authWithOTP(result.otpId, 'EMAIL_CODE', { 'mfaId': mfaId });
}