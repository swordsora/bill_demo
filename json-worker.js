self.onmessage = (event) => {
  try {
    const result = JSON.parse(event.data.text);
    self.postMessage({ id: event.data.id, result });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error.message || String(error) });
  }
};
