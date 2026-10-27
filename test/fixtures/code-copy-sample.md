Here is a Python helper:

```python
def resolve(path, *, strict=False):
    """Resolve a path."""
    if strict:
        return os.path.realpath(path)  # this comment is deliberately very long so that the line exceeds one hundred columns of width
    return path
```

Run it with:

```bash
npm run build && systemctl --user restart codeman-web
```

A config file:

```json
{
  "name": "codeman",
  "nested": { "a": [1, 2, 3] }
}
```

A diagram:

```
┌────────┐     ┌────────┐
│ client │ ──▶ │ server │
└────────┘     └────────┘
```

Steps:

1. First install:

   ```bash
   npm install
   ```

2. Then run the same command again:

   ```bash
   npm run build && systemctl --user restart codeman-web
   ```

A block with a blank line inside:

```go
func main() {
	fmt.Println("tab indented")

	os.Exit(0)
}
```

Done.
