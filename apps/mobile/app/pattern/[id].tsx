// Pattern detail — photo + tiled rendering + capture metadata.
// Editor parity (recolor / save changes) is web-only for v1.

import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { getPattern } from '../../src/api';
import PatternThumb from '../../src/PatternThumb';

export default function PatternDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pattern', id],
    queryFn: () => getPattern(id),
    enabled: typeof id === 'string',
  });

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (isError || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Couldn't load this pattern.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.name}>{data.name}</Text>
      {data.place_name ? (
        <Text style={styles.meta}>📍 {data.place_name}</Text>
      ) : null}
      <Text style={styles.metaSmall}>
        {/* A pattern with no capture behind it has no capture time; fall back
            to when the record was created so this line is always true. */}
        {data.captured_at
          ? `Captured ${new Date(data.captured_at).toLocaleString()}`
          : `Added ${new Date(data.created_at).toLocaleString()}`}
      </Text>

      <View style={styles.thumbWrap}>
        <PatternThumb
          pipeline={data.pipeline}
          layers={(data.layers ?? {}) as Record<string, string>}
          style={styles.thumb}
        />
      </View>

      {data.photo_url ? (
        <View style={styles.photoSection}>
          <Text style={styles.sectionTitle}>Original photo</Text>
          <Image source={{ uri: data.photo_url }} style={styles.photo} />
        </View>
      ) : null}

      <Text style={styles.helperText}>
        Open this pattern on the web app to recolor or share.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: '#a00' },
  name: { fontSize: 24, fontWeight: '700' },
  meta: { fontSize: 14, opacity: 0.7 },
  metaSmall: { fontSize: 12, opacity: 0.5 },
  thumbWrap: {
    aspectRatio: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 16,
  },
  thumb: { width: '100%', height: '100%' },
  photoSection: { marginTop: 24, gap: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '600', opacity: 0.7 },
  photo: { width: '100%', aspectRatio: 1, borderRadius: 8 },
  helperText: {
    fontSize: 12,
    opacity: 0.5,
    marginTop: 32,
    textAlign: 'center',
  },
});
