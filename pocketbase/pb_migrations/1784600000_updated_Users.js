/// <reference path="../pb_data/types.d.ts" />

// The "Invite User" admin flow uses the "create & reset" pattern: it creates a
// user with a throwaway password and then triggers requestPasswordReset, so the
// invitation email IS the password-reset email. This migration rewords that
// shared template to read as a welcome/invitation (it still works for genuine
// password resets) and extends the reset-token lifetime to 3h — a 30-minute
// window is fine for a self-service reset but too short for an emailed invite.
//
// Tradeoff: this template and token duration are shared with the "forgot
// password" flow. If you want a stricter reset-token TTL, lower
// passwordResetToken.duration and shorten invite delivery expectations
// accordingly (keep the "3 hours" copy in the body + the forgot-password form
// in sync). See docs/INVITE_USERS.md.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("_pb_users_auth_")

  unmarshal({
    "passwordResetToken": {
      "duration": 18000
    },
    "resetPasswordTemplate": {
      "subject": "Set your password for {APP_NAME}",
      "body": "<p>Hello,</p>\n<p>An account is ready for you on {APP_NAME}. Click the button below to set your password and sign in. If you requested a password reset, use this same link to choose a new password.</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/reset-password?token={TOKEN}\" target=\"_blank\" rel=\"noopener\">Set your password</a>\n</p>\n<p><i>This link expires in 72 hours. If you weren't expecting this email, you can safely ignore it.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
    }
  }, collection)

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("_pb_users_auth_")

  // Revert to the plain reset wording + 30-minute token.
  unmarshal({
    "passwordResetToken": {
      "duration": 1800
    },
    "resetPasswordTemplate": {
      "subject": "Reset your {APP_NAME} password",
      "body": "<p>Hello,</p>\n<p>Click on the button below to reset your password.</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/reset-password?token={TOKEN}\" target=\"_blank\" rel=\"noopener\">Reset password</a>\n</p>\n<p><i>If you didn't ask to reset your password, you can ignore this email.</i></p>\n<p>\n  Thanks,<br/>\n  {APP_NAME} team\n</p>"
    }
  }, collection)

  return app.save(collection)
})
