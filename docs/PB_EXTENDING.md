# Extending PocketBase

PocketBase can be extended with custom business logic using Go or JavaScript while maintaining a portable backend.

## Choosing Between Go and JavaScript

**Go** - Recommended if:
- You're familiar with Go or have time to learn it
- You need better documentation and more control
- You want to integrate with 3rd party Go libraries
- Note: Go APIs are more verbose

**JavaScript** - Recommended if:
- You want a quick way to explore PocketBase capabilities
- You don't need extensive custom code
- Note: JavaScript is a wrapper around Go APIs, so performance is similar. You can migrate from JS to Go later if needed.

## Capabilities

Both Go and JavaScript support:

### Custom Routes

```javascript
routerAdd("GET", "/hello", (e) => {
    return e.string(200, "Hello world!")
})
```

### Event Hooks

```javascript
onRecordCreateRequest((e) => {
    // Overwrite status to pending for non-superusers
    if (!e.hasSuperuserAuth()) {
        e.record.set("status", "pending")
    }
    e.next()
}, "posts")
```

### Custom Console Commands

```javascript
$app.rootCmd.addCommand(new Command({
    use: "hello",
    run: (cmd, args) => {
        console.log("Hello world!")
    },
}))
```

For more details, see the official PocketBase documentation on extending with Go or JavaScript.
