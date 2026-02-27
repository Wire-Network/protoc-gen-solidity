# protoc-gen-solidity

A `protoc` plugin that generates Solidity libraries with full protobuf3 wire
format **encode** and **decode** support for on-chain / off-chain
interoperability.

## Quick Start

```bash
pnpm install
pnpm dist                # tsc → lib/, esbuild → dist/bundle/

# Generate Solidity from .proto files
protoc \
  --plugin=protoc-gen-solidity=./dist/bundle/protoc-gen-solidity.cjs \
  --solidity_out=./test/generated \
  testprotos/example.proto
```

## Architecture

```
.proto → protoc --plugin=protoc-gen-solidity
          ├── ProtobufRuntime.sol    (shared wire format primitives)
          └── Example.sol         (struct + codec library per message)
```

### Generated Output

Each `.proto` file produces a single `.sol` containing:

- **Struct definitions** — one per message (maps become parallel arrays)
- **Codec libraries** — `MessageNameCodec.encode(msg) → bytes` and
  `MessageNameCodec.decode(bytes) → msg` with tag-dispatch loop

### Runtime Library

`ProtobufRuntime.sol` provides gas-optimized wire primitives with inline
assembly for varint encode/decode hot paths (~40–60% gas reduction vs pure
Solidity).

## Type Mapping

| Proto             | Solidity      | Wire Type         |
|-------------------|---------------|-------------------|
| `int32/int64`     | `int32/int64` | Varint            |
| `uint32/uint64`   | `uint32/uint64` | Varint          |
| `sint32/sint64`   | `int32/int64` | Varint (ZigZag)   |
| `bool`            | `bool`        | Varint            |
| `string`          | `string`      | Length-delimited   |
| `bytes`           | `bytes`       | Length-delimited   |
| `fixed32/fixed64` | `uint32/uint64` | Fixed           |
| `sfixed32/sfixed64` | `int32/int64` | Fixed           |
| `enum`            | `uint64`      | Varint            |
| `message`         | `struct`      | Length-delimited   |
| `repeated T`      | `T[]`         | Sequential tags    |
| `map<K,V>`        | `K[] + V[]`   | Length-delimited   |

## Plugin Parameters

Pass via `--sol_opt`:

```bash
protoc --sol_opt=log_level=debug ...
```

| Parameter   | Values                         | Default |
|-------------|--------------------------------|---------|
| `log_level` | `trace,debug,info,warn,error`  | `info`  |

## Project Structure

```
src/
├── index.ts              # stdin/stdout protoc bridge
├── plugin.ts             # request processing & descriptor walking
├── generator/
│   ├── type-map.ts       # proto → Solidity type mapping
│   ├── field.ts          # field-level encode/decode codegen
│   ├── message.ts        # message-level .sol file generation
│   └── runtime.ts        # ProtobufRuntime.sol emitter
└── util/
    ├── logger.ts         # tracer-based stderr logging
    └── names.ts          # naming convention utilities
```

## Build

| Command         | Output                            |
|-----------------|-----------------------------------|
| `pnpm build`    | `lib/` — compiled TypeScript      |
| `pnpm bundle`   | `dist/bundle/` — esbuild CJS     |
| `pnpm dist`     | Both                              |

## License

MIT
