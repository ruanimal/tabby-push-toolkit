#!/bin/sh
# Decode standard Base64 from stdin. Requires only POSIX shell builtins.
LC_ALL=C
export LC_ALL
alphabet=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/
acc=0 bits=0 count=0 pads=0
cr=$(printf '\r')
tab=$(printf '\t')
fail() {
    printf '%s\n' 'Invalid or incomplete Base64 input' >&2
    exit 1
}
while IFS= read -r line || [ -n "$line" ]; do
    while [ -n "$line" ]; do
        tail=${line#?}
        char=${line%"$tail"}
        line=$tail
        case "$char" in
            ' '|"$tab"|"$cr") continue ;;
            '=') pads=$((pads + 1)); [ "$pads" -le 2 ] || fail; continue ;;
        esac
        [ "$pads" -eq 0 ] || fail
        prefix=${alphabet%%"$char"*}
        [ "$prefix" != "$alphabet" ] || fail
        value=${#prefix}
        count=$(((count + 1) % 4))
        acc=$((acc * 64 + value))
        bits=$((bits + 6))
        if [ "$bits" -ge 8 ]; then
            bits=$((bits - 8))
            divisor=$((1 << bits))
            byte=$((acc / divisor))
            acc=$((acc % divisor))
            octal=$(printf '%03o' "$byte")
            printf '%b' "\0$octal"
        fi
    done
done
case "$count:$pads:$acc" in
    0:0:0|2:2:0|3:1:0) ;;
    *) fail ;;
esac
