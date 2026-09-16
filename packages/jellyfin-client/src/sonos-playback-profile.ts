// Pinned to the Jellyfin 10.11.11 negotiation contract in ADR 0001.
const SONOS_DEVICE_PROFILE = {
  Name: "Sonofin Sonos",
  MaxStreamingBitrate: 8_000_000,
  MaxStaticBitrate: 8_000_000,
  MaxStaticMusicBitrate: 8_000_000,
  MusicStreamingTranscodingBitrate: 320_000,
  DirectPlayProfiles: [
    { Container: "mp3", AudioCodec: "mp3", Type: "Audio" },
    { Container: "aac", AudioCodec: "aac", Type: "Audio" },
    { Container: "m4a,mp4", AudioCodec: "aac", Type: "Audio" },
    { Container: "flac", AudioCodec: "flac", Type: "Audio" },
  ],
  TranscodingProfiles: [
    {
      Container: "mp3",
      AudioCodec: "mp3",
      Type: "Audio",
      Protocol: "http",
      Context: "Streaming",
      MaxAudioChannels: "2",
      EstimateContentLength: true,
      EnableAudioVbrEncoding: false,
    },
  ],
  ContainerProfiles: [],
  CodecProfiles: [
    {
      Type: "Audio",
      Codec: "mp3",
      Container: "mp3",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "AudioChannels",
          Value: "2",
          IsRequired: true,
        },
        {
          Condition: "LessThanEqual",
          Property: "AudioSampleRate",
          Value: "48000",
          IsRequired: true,
        },
      ],
      ApplyConditions: [],
    },
    {
      Type: "Audio",
      Codec: "aac",
      Container: "aac,m4a,mp4",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "AudioChannels",
          Value: "2",
          IsRequired: true,
        },
        {
          Condition: "LessThanEqual",
          Property: "AudioSampleRate",
          Value: "48000",
          IsRequired: true,
        },
      ],
      ApplyConditions: [],
    },
    {
      Type: "Audio",
      Codec: "flac",
      Container: "flac",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "AudioChannels",
          Value: "2",
          IsRequired: true,
        },
        {
          Condition: "LessThanEqual",
          Property: "AudioSampleRate",
          Value: "48000",
          IsRequired: true,
        },
        {
          Condition: "LessThanEqual",
          Property: "AudioBitDepth",
          Value: "16",
          IsRequired: true,
        },
      ],
      ApplyConditions: [],
    },
  ],
  SubtitleProfiles: [],
} as const;

export function sonosPlaybackInfoRequest(userId: string): object {
  return {
    UserId: userId,
    MaxStreamingBitrate: 8_000_000,
    MaxAudioChannels: 2,
    EnableDirectPlay: true,
    EnableDirectStream: false,
    EnableTranscoding: true,
    AllowVideoStreamCopy: false,
    AllowAudioStreamCopy: false,
    DeviceProfile: SONOS_DEVICE_PROFILE,
  };
}
