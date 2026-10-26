# The plugin prepends configuration and decode_chunk(), then invokes sh -c.
LC_ALL=C
export LC_ALL
umask 077
report() { printf '\036PT%s:%s\037\n' "$token" "$1"; }
fail() { report "ERROR:$1"; exit 1; }
boot_stage= file_stage= tty_state=
cleanup() {
    [ -z "$boot_stage" ] || rm -rf "$boot_stage"
    [ -z "$file_stage" ] || rm -rf "$file_stage"
    [ -z "$tty_state" ] || stty "$tty_state"
    return 0
}
trap 'cleanup; report STOPPED' 0
trap 'exit 130' 1 2 15
for tool in mkdir rm mv ln wc; do
    command -v "$tool" >/dev/null 2>&1 || fail "MISSING_$tool"
done
if [ "$executable" = 1 ]; then
    command -v chmod >/dev/null 2>&1 || fail MISSING_chmod
fi
if command -v stty >/dev/null 2>&1; then
    tty_state=$(stty -g 2>/dev/null) || tty_state=
    [ -z "$tty_state" ] || stty -echo
fi
find_receiver() {
    candidate=$(command -v "$1" 2>/dev/null) || return 1
    [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
    receiver=$candidate
}
find_sender() {
    candidate=$(command -v "$1" 2>/dev/null) || return 1
    [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
    sender=$candidate
}
platform=unknown architecture=unknown
available=0
if find_receiver "$bootstrap_receiver" || find_receiver trz; then
    available=1
fi
sender_available=0
if find_sender "$bootstrap_sender" || find_sender tsz; then
    sender_available=1
fi
if [ "$available" != 1 ] || { [ "$bootstrap_only" = 1 ] && [ "$sender_available" != 1 ]; }; then
    command -v uname >/dev/null 2>&1 || fail MISSING_uname
    platform=$(uname -s) || fail UNAME
    architecture=$(uname -m) || fail UNAME
    case "$platform:$architecture" in
        Linux:mips|Linux:mipsel)
            # uname reports mips for both byte orders. Inspect the running shell's ELF header.
            command -v od >/dev/null 2>&1 || fail MISSING_od
            detected=
            for binary in "/proc/$$/exe" "$(command -v sh)" /bin/sh; do
                # BusyBox can return the bare applet name sh instead of a file path.
                case "$binary" in /*) ;; *) continue ;; esac
                header=$(od -A n -t u1 -N 6 "$binary" 2>/dev/null) || continue
                set -- $header
                case "$*" in
                    '127 69 76 70 1 1') detected=mipsel ;;
                    '127 69 76 70 1 2') detected=mips ;;
                    *) continue ;;
                esac
                break
            done
            [ -n "$detected" ] || fail ENDIANNESS
            architecture=$detected
            ;;
    esac
fi
report "PROBE:$platform:$architecture:$available:$sender_available"
IFS= read -r action || fail INPUT
case "$action" in
    BOOT:*)
        command -v chmod >/dev/null 2>&1 || fail MISSING_chmod
        receiver=$bootstrap_receiver
        details=${action#BOOT:}
        sender_size=${details##*:}
        details=${details%:*}
        expected_crc=${details##*:}
        expected=${details%:*}
        mkdir -p "$receiver_dir" || fail RECEIVER_DIRECTORY
        stage_candidate="$receiver_dir/.push-$token"
        mkdir "$stage_candidate" || fail RECEIVER_STAGE
        boot_stage=$stage_candidate
        total=0 sum_a=1 sum_b=0 sequence=0
        : > "$boot_stage/trz" || fail RECEIVER_WRITE
        detect_native_decoder
        if [ -n "$native_flag" ]; then report BOOT:NATIVE; else report BOOT:SHELL; fi
        while IFS= read -r line; do
            [ "$line" != END ] || break
            if [ -n "$native_flag" ]; then
                decode_native_chunk "$line" >> "$boot_stage/trz" || fail DECODE
                checksum=$chunk_crc
            else
                decode_chunk "$line" >> "$boot_stage/trz" || fail DECODE
                checksum=$sum_a:$sum_b
            fi
            sequence=$((sequence + 1))
            report "ACK:$sequence:$total:$checksum"
        done
        [ "$line" = END ] || fail INPUT
        if [ -n "$native_flag" ]; then
            check=$(cksum < "$boot_stage/trz") || fail CHECKSUM
            [ "$check" = "$expected_crc ${expected%%:*}" ] || fail CHECKSUM
        else
            [ "$total:$sum_a:$sum_b" = "$expected" ] || fail CHECKSUM
        fi
        actual=$(wc -c < "$boot_stage/trz") || fail SIZE
        [ "$actual" -eq "$total" ] || fail SIZE
        chmod u+x "$boot_stage/trz" || fail CHMOD
        "$boot_stage/trz" --version >/dev/null 2>&1 || fail RECEIVER_EXEC
        [ ! -d "$receiver" ] || fail RECEIVER_DIRECTORY
        # Run the staged receiver first; publish it only after tsz is fully verified.
        receiver="$boot_stage/trz"
        report SENDER_READY
        IFS= read -r action || fail INPUT
        [ "$action" = GO ] || fail CANCELLED
        # Quiet mode also disables the client's progress bar.
        "$receiver" -y -B "$receiver_buffer_size" -- "$boot_stage"
        rc=$?
        [ "$rc" = 0 ] || fail TRANSFER
        report SENDER_RECEIVED
        IFS= read -r action || fail INPUT
        [ "$action" = COMMIT ] || fail CANCELLED
        [ -f "$boot_stage/tsz" ] && [ ! -L "$boot_stage/tsz" ] || fail SENDER_MISSING
        actual=$(wc -c < "$boot_stage/tsz") || fail SIZE
        [ "$actual" -eq "$sender_size" ] || fail SIZE
        chmod u+x "$boot_stage/tsz" || fail CHMOD
        "$boot_stage/tsz" --version >/dev/null 2>&1 || fail SENDER_EXEC
        [ ! -d "$receiver_dir/tsz" ] || fail SENDER_COMMIT
        mv -f "$boot_stage/tsz" "$receiver_dir/tsz" || fail SENDER_COMMIT
        mv -f "$boot_stage/trz" "$bootstrap_receiver" || fail RECEIVER_COMMIT
        receiver=$bootstrap_receiver
        report SENDER_DONE
        if [ "$bootstrap_only" = 1 ]; then
            report BOOTSTRAP_DONE
            exit 0
        fi
        ;;
    USE|USE:*)
        [ "$available" = 1 ] || fail RECEIVER_MISSING
        if [ "$bootstrap_only" = 1 ]; then
            if [ "$sender_available" = 1 ]; then
                report BOOTSTRAP_DONE
                exit 0
            fi
            case "$action" in
                USE:*)
                    sender_size=${action#USE:}
                    case "$sender_size" in ''|*[!0-9]*) fail INPUT ;; esac
                    ;;
                *) fail INPUT ;;
            esac
            command -v chmod >/dev/null 2>&1 || fail MISSING_chmod
            mkdir -p "$receiver_dir" || fail RECEIVER_DIRECTORY
            stage_candidate="$receiver_dir/.push-$token"
            mkdir "$stage_candidate" || fail SENDER_STAGE
            file_stage=$stage_candidate
            IFS= read -r action || fail INPUT
            [ "$action" = GO ] || fail CANCELLED
            "$receiver" -y -B "$receiver_buffer_size" -- "$file_stage"
            rc=$?
            [ "$rc" = 0 ] || fail TRANSFER
            report SENDER_RECEIVED
            IFS= read -r action || fail INPUT
            [ "$action" = COMMIT ] || fail CANCELLED
            received="$file_stage/tsz"
            [ -f "$received" ] && [ ! -L "$received" ] || fail SENDER_MISSING
            actual=$(wc -c < "$received") || fail SIZE
            [ "$actual" -eq "$sender_size" ] || fail SIZE
            chmod u+x "$received" || fail CHMOD
            "$received" --version >/dev/null 2>&1 || fail SENDER_EXEC
            [ ! -d "$bootstrap_sender" ] || fail SENDER_COMMIT
            mv -f "$received" "$bootstrap_sender" || fail SENDER_COMMIT
            rm -rf "$file_stage"
            file_stage=
            report SENDER_DONE
            report BOOTSTRAP_DONE
            exit 0
        fi
        ;;
    *) fail CANCELLED ;;
esac
mkdir -p "$destination" || fail DESTINATION
target="$destination/$filename"
[ ! -d "$target" ] && [ ! -L "$target" ] || fail TARGET_TYPE
if [ "$overwrite" != 1 ] && [ -e "$target" ]; then fail EXISTS; fi
stage_candidate="$destination/.push-$token"
mkdir "$stage_candidate" || fail FILE_STAGE
file_stage=$stage_candidate
report READY
IFS= read -r action || fail INPUT
[ "$action" = GO ] || fail CANCELLED
"$receiver" -y -B "$receiver_buffer_size" -- "$file_stage"
rc=$?
[ "$rc" = 0 ] || fail TRANSFER
report RECEIVED
# Some trz implementations exit zero on cancellation or protocol error.
# Only the client's successful protocol completion authorizes final replacement.
IFS= read -r action || fail INPUT
[ "$action" = COMMIT ] || fail CANCELLED
received="$file_stage/$filename"
[ -f "$received" ] && [ ! -L "$received" ] || fail FILE_MISSING
actual=$(wc -c < "$received") || fail SIZE
[ "$actual" -eq "$file_size" ] || fail SIZE
[ "$executable" != 1 ] || chmod u+x "$received" || fail CHMOD
[ ! -d "$target" ] && [ ! -L "$target" ] || fail TARGET_TYPE
if [ "$overwrite" != 1 ] && [ -e "$target" ]; then fail EXISTS; fi
if [ "$overwrite" = 1 ]; then
    mv -f "$received" "$target" || fail FILE_COMMIT
else
    # A same-filesystem hard link refuses an existing file atomically.
    ln "$received" "$target" || fail FILE_COMMIT
fi
cleanup
boot_stage= file_stage= tty_state=
report DONE
