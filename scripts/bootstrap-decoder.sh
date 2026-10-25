# Sourced by the temporary remote worker. POSIX shell builtins only.
# Each independently padded Base64 line is acknowledged after a successful write.
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
