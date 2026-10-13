#!/usr/bin/env python3
#
# ACS File Summariser
# Streams a downsampled summary of a TDMS file to stdout as NDJSON.
#
# Reads via TdmsFile.data_chunks(), which decodes each on-disk chunk
# exactly once and shares it across every channel in the group. This
# matters for interleaved TDMS data (common for synchronised multi-channel
# DAQ writes): nptdms can only decode an interleaved chunk as a whole, so
# reading channel-by-channel (each channel calling read_data() over the
# same offset range) re-decodes the same bytes once per channel - peak
# memory and CPU scale with the number of channels in the group. Reading
# chunk-by-chunk instead decodes once and slices out each channel's data
# from that single decode.
#
# Copyright 2026 University of Sheffield

import sys
import json
import math

import numpy as np
from nptdms import TdmsFile


def channel_timing(channel):
    """Return (start_ns, increment_ns) as integers, or None if this
    channel has no waveform timing properties (e.g. non-waveform data)."""
    props = channel.properties
    if "wf_start_time" not in props or "wf_increment" not in props:
        return None

    start_time = props["wf_start_time"]
    increment = float(props["wf_increment"])
    start_offset = float(props.get("wf_start_offset", 0.0))

    start_ns = int(start_time.astype("datetime64[ns]").astype("int64"))
    start_ns += round(start_offset * 1e9)
    increment_ns = round(increment * 1e9)

    return start_ns, increment_ns


# numpy dtype kinds that are numeric signals: bool, signed/unsigned int,
# float. Anything else (strings, timestamps, complex) isn't written.
NUMERIC_KINDS = "biuf"


def summarise(file_path, step):
    def emit(row):
        sys.stdout.write(json.dumps(row))
        sys.stdout.write("\n")
        sys.stdout.flush()

    with TdmsFile.open(file_path) as tdms_file:
        timings = {
            (group.name, channel.name): channel_timing(channel)
            for group in tdms_file.groups()
            for channel in group.channels()
        }

        for data_chunk in tdms_file.data_chunks():
            for group_chunk in data_chunk.groups():
                for channel_chunk in group_chunk.channels():
                    # Channels without waveform timing (e.g. FlexLogger's
                    # Events/Events_time log) aren't sampled signals and
                    # have no time base, so they're left out of the summary.
                    timing = timings[(group_chunk.name, channel_chunk.name)]
                    if timing is None:
                        continue
                    start_ns, increment_ns = timing

                    length = len(channel_chunk)
                    if length == 0:
                        continue

                    offset = channel_chunk.offset

                    # First local index in this chunk that lands on the
                    # global step grid (global index = offset + local_idx).
                    local_start = (-offset) % step
                    if local_start >= length:
                        continue

                    # String channels come back as plain lists, not arrays.
                    values = np.asarray(channel_chunk[:])
                    if values.dtype.kind not in NUMERIC_KINDS:
                        continue

                    for local_idx in range(local_start, length, step):
                        abs_idx = offset + local_idx
                        timestamp_ns = start_ns + abs_idx * increment_ns

                        # Bools become 1.0/0.0. NaN/inf are dropped: Influx
                        # can't store them, and json.dumps would emit bare
                        # NaN/Infinity tokens that JSON.parse rejects.
                        value = float(values[local_idx])
                        if not math.isfinite(value):
                            continue

                        row = {
                            "group": group_chunk.name,
                            "channel": channel_chunk.name,
                            "value": value,
                            # Emitted as a string: nanosecond epoch timestamps
                            # exceed what a JSON/JS float can represent exactly.
                            "timestamp_ns": str(timestamp_ns),
                        }
                        emit(row)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: tdms_summarise.py <file> <step>", file=sys.stderr)
        sys.exit(2)

    try:
        summarise(sys.argv[1], max(1, int(sys.argv[2])))
    except Exception as e:
        print(f"Error summarising TDMS file: {e}", file=sys.stderr)
        sys.exit(1)
