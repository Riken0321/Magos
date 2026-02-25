from HttpServer.myFlask import FlaskApp

if __name__ == "__main__":
    FlaskApp(_host="0.0.0.0", _port=5500, _debug=False, _threaded=True)
