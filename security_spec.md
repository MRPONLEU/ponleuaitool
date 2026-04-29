# Firestore Security Specification - PONLEU-AI

## Data Invariants
1. **Users**: A user document Must match the authenticated user's UID and email. The role can only be set to "admin" by the system (or if the email is "henrythonny@gmail.com").
2. **Templates**: Can be created by any signed-in user. Admins can manage all templates. Users can update their own templates.
3. **History**: Each record Must be tied to the current user's UID. Users can only list and delete their own history.
4. **Settings**: Only admins can modify global settings.
5. **Profiles**: Users can only read and write their own profile data.

## The "Dirty Dozen" Payloads (Targets for Rejection)
1. **Identity Spoofing**: Attempt to create a user profile for another UID.
2. **Role Escalation**: Attempt to set `role: "admin"` during user registration.
3. **Shadow Fields**: Adding an `isAdmin: true` field to a template or history item.
4. **Orphaned Writes**: Creating a template with a `createdBy` field that doesn't match the current user.
5. **Timeline Tampering**: Providing a client-side timestamp instead of `serverTimestamp()` for `createdAt` or `updatedAt`.
6. **ID Poisoning**: Using a 2KB string as a document ID for a history item.
7. **Resource Exhaustion**: Sending a 2MB string in the `prompt` field.
8. **PII Leak**: Authenticated user attempting to list all items in the `users` collection.
9. **State Shortcutting**: Modifying the `createdBy` field of an existing template.
10. **Admin Lockout**: Authenticated (non-admin) user attempting to write to `settings/global`.
11. **Cross-User Exposure**: User A attempting to `get` User B's history item by ID.
12. **Blanket Read Attack**: Attempting to query `history` without a `where("userId", "==", uid)` clause.

## Test Runner Plan
The rules will be tested to ensure these payloads return `PERMISSION_DENIED`.
