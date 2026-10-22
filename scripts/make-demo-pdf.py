"""Generate an entirely synthetic 16:9 PDF fixture; no client content."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

root = Path(__file__).resolve().parents[1]
out = root / "public/demo/arslive-demo.pdf"
out.parent.mkdir(parents=True, exist_ok=True)
c = canvas.Canvas(str(out), pagesize=(1280,720))
c.setTitle("ArsLive - Test presentation")
for number, lines in enumerate([
    ("Ideas bring", "us together.", "Your presentation. Your camera. One conversation."),
    ("Make your", "point clear.", "Use the marker to underline a thought or draw a connection."),
    ("Let's start", "a conversation.", "Ask a question in the chat. This is a synthetic test deck."),
],1):
    c.setFillColor(HexColor("#eee9dc")); c.rect(0,0,1280,720,fill=1,stroke=0)
    c.setStrokeColor(HexColor("#c9c2ad"));c.setLineWidth(1)
    for r in range(180,470,43): c.circle(1130,400,r,stroke=1,fill=0)
    c.setFillColor(HexColor("#d5b66f"));c.circle(1050,400,80,stroke=0,fill=1)
    c.setFillColor(HexColor("#232720"));c.setFont("Helvetica",18);c.drawString(70,650,"ARSLIVE")
    c.setFont("Times-Roman",86);c.drawString(70,440,lines[0]);c.drawString(70,348,lines[1])
    c.setFillColor(HexColor("#666b60"));c.setFont("Helvetica",20);c.drawString(73,273,lines[2])
    c.setFont("Helvetica",13);c.drawString(73,65,"SYNTHETIC TEST PRESENTATION - REPLACE WITH YOUR PDF")
    c.drawString(765,65,f"0{number} / 03")
    c.showPage()
c.save()
print(out)
