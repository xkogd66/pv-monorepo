<template>
  <div class="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-40">
    <div class="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
      <h2 class="text-lg font-semibold mb-4">Edit Photo Metadata</h2>

      <form @submit.prevent="saveMetadata">
        <!-- Special handling for coordinates - split into lat/lng -->
        <div class="mb-6 border-l-2 border-indigo-200 pl-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">Coordinates</label>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label for="latitude" class="block text-xs text-gray-600 mb-1">Latitude</label>
              <input 
                type="number" 
                step="any"
                id="latitude" 
                v-model="latitude" 
                class="block w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="e.g., 59.3293"
              />
            </div>
            <div>
              <label for="longitude" class="block text-xs text-gray-600 mb-1">Longitude</label>
              <input 
                type="number" 
                step="any"
                id="longitude" 
                v-model="longitude" 
                class="block w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="e.g., 18.0686"
              />
            </div>
          </div>
        </div>

        <!-- Handle timestamp -->
        <div class="mb-6 border-l-2 border-indigo-200 pl-4">
          <label class="block text-sm font-medium text-gray-700 mb-1">Timestamp</label>
          <!-- Time is a text field, not type="time": native time inputs follow the browser locale (AM/PM). -->
          <div class="grid grid-cols-2 gap-2">
            <input
              type="date"
              v-model="dateValue"
              class="block w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            <input
              type="text"
              v-model="timeValue"
              inputmode="numeric"
              maxlength="5"
              placeholder="HH:mm"
              pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
              title="24-hour time, e.g. 13:45"
              class="block w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
        </div>        <div class="flex justify-end gap-3 border-t pt-4 mt-6">
          <button 
            type="button" 
            @click="$emit('close')" 
            class="bg-gray-500 text-white px-4 py-2 rounded-md hover:bg-gray-600 transition-colors duration-150"
          >
            Cancel
          </button>
          <button 
            type="submit"
            class="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 transition-colors duration-150"
          >
            Save Changes
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    metadata: Object
  },
  data() {
    return {
      editableMetadata: JSON.parse(JSON.stringify(this.metadata || {})),
      expanded: {}
    };
  },
  methods: {
    toggleExpand(key) {
      this.$set(this.expanded, key, !this.expanded[key]);
    },
    addArrayItem(key) {
      this.editableMetadata[key].push('');
    },
    removeArrayItem(key, index) {
      this.editableMetadata[key].splice(index, 1);
    },
    saveMetadata() {
      this.$emit('save', this.editableMetadata);
    }
  }
};
</script>

<script setup>
import { reactive, ref, watch } from 'vue';
import apiService from '../services/api.js';
import { useToast } from '../composables/useToast';
import {
  toDatetimeLocalPreservingOffset,
  fromDatetimeLocalPreservingOffset
} from '../utils/timestamp.js';

const props = defineProps({
  photo: { type: Object, required: true },
  photoMetadataLookup: { type: Object, required: true }
});

const emit = defineEmits(['save', 'close']);

const editableMetadata = reactive({ ...props.photoMetadataLookup[props.photo.name] });
const expanded = reactive({});
const { showToast } = useToast();

// Timestamp value for native datetime-local input (YYYY-MM-DDTHH:mm format)
const timestampValue = ref('');

// Initialize timestamp value without converting away original metadata timezone.
if (editableMetadata.timestamp && editableMetadata.timestamp !== 'Invalid Date Invalid Date') {
  timestampValue.value = toDatetimeLocalPreservingOffset(editableMetadata.timestamp);
}

// Date and 24h time are separate fields; timestampValue is "YYYY-MM-DDTHH:mm" built from them.
const [initialDate = '', initialTime = ''] = timestampValue.value.split('T');
const dateValue = ref(initialDate);
const timeValue = ref(initialTime);
watch([dateValue, timeValue], ([d, t]) => {
  timestampValue.value = d && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? `${d}T${t}` : '';
});

// Keep editableMetadata.timestamp in sync with picker
watch(timestampValue, (newVal) => {
  editableMetadata.timestamp = fromDatetimeLocalPreservingOffset(
    newVal,
    props.photoMetadataLookup[props.photo.name]?.timestamp
  );
});

// Parse coordinates into separate lat/lng fields
const parseCoordinates = (coordString) => {
  if (!coordString || coordString === 'not found') return { lat: '', lng: '' };
  const parts = coordString.split(',');
  return {
    lat: parts[0]?.trim() || '',
    lng: parts[1]?.trim() || ''
  };
};

const initialCoords = parseCoordinates(editableMetadata.coordinates);
const latitude = ref(initialCoords.lat);
const longitude = ref(initialCoords.lng);

const saveMetadata = async () => {
  // A date without a valid time would save an empty timestamp and wipe the old one.
  if (dateValue.value && !timestampValue.value) {
    showToast('Enter the time as HH:mm (24-hour), e.g. 13:45', { type: 'warning' });
    return;
  }
  try {
    // Combine latitude and longitude back into coordinates string
    if (latitude.value && longitude.value) {
      editableMetadata.coordinates = `${latitude.value},${longitude.value}`;
    } else if (!latitude.value && !longitude.value) {
      editableMetadata.coordinates = 'not found';
    } else {
      // If only one is provided, keep the original or set to 'not found'
      editableMetadata.coordinates = editableMetadata.coordinates || 'not found';
    }
    
    console.log('Saving metadata:', editableMetadata);
    
    // Get the complete path from the metadata sourceImage field
    const currentMetadata = props.photoMetadataLookup[props.photo.name];
    const sourceImage = currentMetadata?.sourceImage || props.photo.name;
    console.log('Source image path:', sourceImage);
    
    // Extract folder path and object name from sourceImage
    const pathParts = sourceImage.split('/');
    const objectName = pathParts.pop(); // Get the filename
    const folderPath = pathParts.join('/'); // Get the folder path
    
    console.log('Extracted folderPath:', folderPath, 'objectName:', objectName);
    
    // Send the updated metadata to the backend using API service
    console.log('Making request to update metadata for:', folderPath, objectName);
    
    const result = await apiService.updatePhotoMetadata(folderPath, objectName, editableMetadata);
    console.log('Metadata update result:', result);

    // Update the local metadata lookup
    props.photoMetadataLookup[props.photo.name] = { ...editableMetadata };
    
    showToast('Metadata saved', { type: 'success' });
    emit('save', editableMetadata);
    emit('close');
    
  } catch (error) {
    console.error('Error saving metadata:', error);
    showToast(`Failed to save metadata: ${error.message}`, { type: 'error' });
  }
};

const addArrayItem = (key) => {
  editableMetadata[key].push('');
};

const removeArrayItem = (key, index) => {
  editableMetadata[key].splice(index, 1);
};

const toggleExpand = (key) => {
  expanded[key] = !expanded[key];
};
</script>