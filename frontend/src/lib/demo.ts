import type { OptimiseDayRequest } from "./api";

export interface DemoDay {
  key: string;
  title: string;
  subtitle: string;
  zoom: number;
  names: Record<string, string>;
  request: OptimiseDayRequest;
}

// Sample days for exercising the pipeline before trip storage exists.
// Coordinates are WGS-84. Opening hours are illustrative, not verified.
export const DEMO_DAYS: DemoDay[] = [
  {
    key: "sg",
    title: "Singapore",
    subtitle: "Marina Bay & Chinatown, on foot",
    zoom: 13,
    names: {
      merlion: "Merlion Park",
      gardens: "Gardens by the Bay",
      chinatown: "Chinatown Heritage Centre",
      lau_pa_sat: "Lau Pa Sat (lunch)",
      national_gallery: "National Gallery",
    },
    request: {
      country: "SG",
      mode: "walking",
      start: { lat: 1.2834, lng: 103.8607 },
      stops: [
        { id: "merlion", location: { lat: 1.2868, lng: 103.8545 }, visit_min: 30 },
        {
          id: "gardens",
          location: { lat: 1.2816, lng: 103.8636 },
          visit_min: 120,
          opens: "09:00",
          closes: "21:00",
        },
        {
          id: "chinatown",
          location: { lat: 1.2833, lng: 103.8443 },
          visit_min: 60,
          opens: "09:30",
          closes: "18:30",
        },
        {
          id: "lau_pa_sat",
          location: { lat: 1.2807, lng: 103.8504 },
          visit_min: 60,
          opens: "11:30",
          closes: "14:00",
          mandatory: true,
        },
        {
          id: "national_gallery",
          location: { lat: 1.2903, lng: 103.8515 },
          visit_min: 90,
          opens: "10:00",
          closes: "19:00",
        },
      ],
    },
  },
  {
    key: "sh",
    title: "Shanghai",
    subtitle: "The Bund, Yu Garden & Nanjing Road",
    zoom: 13,
    names: {
      bund: "The Bund 外滩",
      yu_garden: "Yu Garden 豫园",
      nanjing_road: "Nanjing Road 南京路",
      museum: "Shanghai Museum 上海博物馆",
      xintiandi: "Xintiandi 新天地 (dinner)",
    },
    request: {
      country: "CN",
      mode: "walking",
      start: { lat: 31.2335, lng: 121.4782 },
      stops: [
        { id: "bund", location: { lat: 31.24, lng: 121.49 }, visit_min: 60 },
        {
          id: "yu_garden",
          location: { lat: 31.2272, lng: 121.4921 },
          visit_min: 90,
          opens: "09:00",
          closes: "16:30",
        },
        { id: "nanjing_road", location: { lat: 31.2355, lng: 121.4808 }, visit_min: 60 },
        {
          id: "museum",
          location: { lat: 31.2283, lng: 121.4751 },
          visit_min: 120,
          opens: "09:00",
          closes: "17:00",
        },
        {
          id: "xintiandi",
          location: { lat: 31.2198, lng: 121.4752 },
          visit_min: 90,
          opens: "18:00",
          closes: "22:00",
        },
      ],
    },
  },
];
