// "Hunt" tab — capture a tile photo, send to the backend, save as a
// pattern. The whole loop is one screen so the user-facing flow
// matches the field-trip mental model: open app, point, shoot, save.

import { useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useQueryClient } from '@tanstack/react-query';
import type { PipelineOutput } from '@habaneta/api-types';
import {
  runImageImport,
  uploadAndSavePattern,
} from '../../src/api';
import PatternThumb from '../../src/PatternThumb';

type Phase = 'idle' | 'analyzing' | 'review' | 'saving';

interface CaptureGeo {
  lat: number;
  lng: number;
  placeName: string | null;
}

export default function HuntScreen() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineOutput | null>(null);
  // The run that produced `pipeline`. Sent on save so the pattern records
  // what settings and pipeline version made it.
  const [jobId, setJobId] = useState<string | null>(null);
  const [geo, setGeo] = useState<CaptureGeo | null>(null);
  const [name, setName] = useState('');
  const [statusLine, setStatusLine] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPhase('idle');
    setPhotoUri(null);
    setPipeline(null);
    setJobId(null);
    setGeo(null);
    setName('');
    setStatusLine('');
    setError(null);
  };

  const captureGeoBestEffort = async (): Promise<CaptureGeo | null> => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return null;
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      let placeName: string | null = null;
      try {
        const places = await Location.reverseGeocodeAsync({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        const p = places[0];
        if (p) {
          placeName = [p.name, p.city, p.country].filter(Boolean).join(', ');
        }
      } catch {
        /* reverse-geocode is optional */
      }
      return {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        placeName,
      };
    } catch {
      return null;
    }
  };

  const onCapture = async () => {
    setError(null);
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.9,
      exif: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setPhotoUri(asset.uri);
    if (!name) setName('');
    // Geo + analyze run concurrently — geo permission prompt and the
    // backend extraction don't need to wait on each other.
    setPhase('analyzing');
    setStatusLine('uploading…');
    const geoPromise = captureGeoBestEffort();
    try {
      const imported = await runImageImport(asset.uri, {
        contentType: asset.mimeType ?? 'image/jpeg',
        onStatus: (s) => setStatusLine(s),
      });
      setPipeline(imported.output);
      setJobId(imported.jobId);
      const g = await geoPromise;
      setGeo(g);
      // Auto-fill name with reverse-geocoded place if we got one.
      if (g?.placeName && !name) setName(g.placeName);
      setPhase('review');
      setStatusLine('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const onPickFromLibrary = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.9,
      exif: false,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setPhotoUri(asset.uri);
    setPhase('analyzing');
    setStatusLine('uploading…');
    try {
      const imported = await runImageImport(asset.uri, {
        contentType: asset.mimeType ?? 'image/jpeg',
        onStatus: (s) => setStatusLine(s),
      });
      setPipeline(imported.output);
      setJobId(imported.jobId);
      setPhase('review');
      setStatusLine('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('idle');
    }
  };

  const onSave = async () => {
    if (!pipeline || !photoUri) return;
    if (!name.trim()) {
      Alert.alert('Name your pattern', 'Pick a short name for the collection.');
      return;
    }
    const layers: Record<string, string> = {};
    pipeline.palette.forEach((p, i) => {
      layers[`layer-${i}`] = p.hex;
    });
    if (pipeline.contour) layers.contour = pipeline.contour.hex;

    setPhase('saving');
    setError(null);
    try {
      await uploadAndSavePattern(photoUri, 'image/jpeg', {
        name: name.trim(),
        family: 'My Imports',
        kind: 'floor',
        captured_at: new Date().toISOString(),
        geo_lat: geo?.lat ?? null,
        geo_lng: geo?.lng ?? null,
        place_name: geo?.placeName ?? null,
        pipeline,
        layers,
        ...(jobId ? { job_id: jobId } : {}),
        source: 'mobile',
      });
      qc.invalidateQueries({ queryKey: ['patterns'] });
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('review');
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      {phase === 'idle' && !photoUri && (
        <View style={styles.idleCard}>
          <Text style={styles.title}>Hunt</Text>
          <Text style={styles.subtitle}>
            Capture a tile pattern. Geolocation tags are optional.
          </Text>
          <Pressable style={styles.primaryBtn} onPress={onCapture}>
            <Text style={styles.primaryBtnLabel}>📷 Capture</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={onPickFromLibrary}>
            <Text style={styles.secondaryBtnLabel}>From library</Text>
          </Pressable>
        </View>
      )}

      {photoUri && (
        <View style={styles.previewRow}>
          <Image source={{ uri: photoUri }} style={styles.preview} />
          <View style={styles.previewResult}>
            {pipeline ? (
              <PatternThumb
                pipeline={pipeline}
                layers={layersFromPalette(pipeline)}
                style={styles.thumb}
              />
            ) : (
              <Text style={styles.statusLabel}>{statusLine || 'analyzing…'}</Text>
            )}
          </View>
        </View>
      )}

      {phase === 'review' && pipeline && (
        <View style={styles.formCard}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Cordoba courtyard, Tile #12 …"
          />
          {geo?.placeName ? (
            <Text style={styles.metaLine}>📍 {geo.placeName}</Text>
          ) : geo ? (
            <Text style={styles.metaLine}>
              📍 {geo.lat.toFixed(3)}, {geo.lng.toFixed(3)}
            </Text>
          ) : (
            <Text style={styles.metaLine}>No location captured</Text>
          )}
          <View style={styles.row}>
            <Pressable style={styles.secondaryBtn} onPress={reset}>
              <Text style={styles.secondaryBtnLabel}>Discard</Text>
            </Pressable>
            <Pressable
              style={[
                styles.primaryBtn,
                phase !== 'review' && styles.disabled,
              ]}
              onPress={onSave}
            >
              <Text style={styles.primaryBtnLabel}>Save to collection</Text>
            </Pressable>
          </View>
        </View>
      )}

      {phase === 'saving' && (
        <Text style={styles.statusLabel}>saving…</Text>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function layersFromPalette(pipeline: PipelineOutput): Record<string, string> {
  const out: Record<string, string> = {};
  pipeline.palette.forEach((p, i) => {
    out[`layer-${i}`] = p.hex;
  });
  if (pipeline.contour) out.contour = pipeline.contour.hex;
  return out;
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  idleCard: { gap: 12, alignItems: 'center', paddingVertical: 32 },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, opacity: 0.6, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: '#111',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    minWidth: 200,
    alignItems: 'center',
  },
  primaryBtnLabel: { color: 'white', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ccc',
    alignItems: 'center',
  },
  secondaryBtnLabel: { color: '#111', fontSize: 14 },
  previewRow: { flexDirection: 'row', gap: 8 },
  preview: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: '#eee',
  },
  previewResult: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumb: { width: '100%', height: '100%' },
  statusLabel: { fontSize: 12, opacity: 0.6, textAlign: 'center' },
  formCard: { gap: 8 },
  label: { fontSize: 12, opacity: 0.6, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
  },
  metaLine: { fontSize: 13, opacity: 0.7 },
  row: { flexDirection: 'row', gap: 8, marginTop: 16 },
  disabled: { opacity: 0.5 },
  errorBox: {
    backgroundColor: '#fee',
    borderColor: '#fcc',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  errorText: { color: '#a00', fontSize: 13 },
});
