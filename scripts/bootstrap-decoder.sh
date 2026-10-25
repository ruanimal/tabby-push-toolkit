# Sourced by the temporary remote worker. Fallback uses POSIX shell builtins only.
# Each independently padded Base64 line is acknowledged after a successful write.
detect_native_decoder() {
    native_flag=
    for tool in base64 cksum cat; do
        command -v "$tool" >/dev/null 2>&1 || return 0
    done
    # GNU/BusyBox use -d; BSD/macOS also support -D. Verify decoding and CRC together.
    for flag in -d -D; do
        if printf 'YQ==' | base64 "$flag" > "$boot_stage/chunk" 2>/dev/null; then
            check=$(cksum < "$boot_stage/chunk") || continue
            [ "$check" = '1220704766 1' ] || continue
            native_flag=$flag
            break
        fi
    done
}

decode_native_chunk() {
    [ "${#1}" -le 1024 ] || return 1
    printf '%s' "$1" | base64 "$native_flag" > "$boot_stage/chunk" || return 1
    check=$(cksum < "$boot_stage/chunk") || return 1
    set -- $check
    [ "$#" -eq 2 ] || return 1
    chunk_crc=$1
    bytes=$2
    cat "$boot_stage/chunk" || return 1
    total=$((total + bytes))
}

decode_chunk() {
    encoded=$1
    alphabet=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
    acc=0 bits=0 count=0 pads=0 bytes=0 output=
    next_a=$sum_a next_b=$sum_b
    [ "${#encoded}" -le 1024 ] || return 1
    while [ -n "$encoded" ]; do
        tail=${encoded#?}
        char=${encoded%"$tail"}
        encoded=$tail
        case "$char" in
            '=') pads=$((pads + 1)); [ "$pads" -le 2 ] || return 1; continue ;;
        esac
        [ "$pads" -eq 0 ] || return 1
        prefix=${alphabet%%"$char"*}
        [ "$prefix" != "$alphabet" ] || return 1
        count=$(((count + 1) % 4))
        acc=$((acc * 64 + ${#prefix}))
        bits=$((bits + 6))
        if [ "$bits" -ge 8 ]; then
            bits=$((bits - 8))
            divisor=$((1 << bits))
            byte=$((acc / divisor))
            acc=$((acc % divisor))
            output="$output\\0$((byte / 64))$((byte / 8 % 8))$((byte % 8))"
            next_a=$(((next_a + byte) % 65521))
            next_b=$(((next_b + next_a) % 65521))
            bytes=$((bytes + 1))
        fi
    done
    case "$count:$pads:$acc" in
        0:0:0|2:2:0|3:1:0) ;;
        *) return 1 ;;
    esac
    printf '%b' "$output" || return 1
    sum_a=$next_a sum_b=$next_b
    total=$((total + bytes))
}
